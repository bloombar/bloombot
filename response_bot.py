#!/usr/bin/env python3

"""
Discord bot that responds to incoming messages.
"""

import os
import asyncio
import yaml
from dotenv import load_dotenv
from discord_manager import DiscordManager
from openai import OpenAI
import re

load_dotenv()  # load environment variables from .env file

CONFIG_FILE = "bot_config.yml"  # path to the configuration file
BOT_TOKEN = os.getenv("BOT_TOKEN")  # from .env file
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")  # from .env file
OPEN_AI_DEFAULT_MODEL = "gpt-4o"

# create OpenAI client
openai_client = OpenAI()
openai_threads = {}  # will hold separate threads keyed by username

# load the config data from file
with open(CONFIG_FILE, encoding="utf-8", mode="r") as f:
    config = yaml.safe_load(f)
    # get server name
    SERVER_NAME = config["server"]["name"]
    courses = config["server"]["courses"]

    # get an OpenAI Assistant for each course
    for course in courses:
        # get existing or create new OpenAI assistant
        oa_config = course.get("openai_assistant", {})
        oa_id = oa_config.get("id", None)
        oa_config["instance"] = openai_assistant = (
            (openai_client.beta.assistants.retrieve(assistant_id=oa_id))
            if oa_id
            else openai_client.beta.assistants.create(
                name=oa_config.get("name", f"Teaching Assistant in {course['title']}"),
                instructions=oa_config.get(
                    "instructions",
                    f"You are a professor's assistant in {course['title']}.  Help answer any student questions about the topic of study.",
                ),
                tools=oa_config.get("tools", []),
                model=oa_config.get("model", OPEN_AI_DEFAULT_MODEL),
            )
        )


# start up bot set to create a category, if not yet exists
client = DiscordManager(guild_id=config["server"]["name"], event_loop=True)


# set up bot actions... this will override its default on_ready() routine.
@client.event
async def on_ready():
    """
    Bot is connected to Discord and ready to use.
    """
    print(f"Logged in as: {client.user.name} (ID: {client.user.id})")


@client.event
async def on_message(message):
    """
    Incoming message handler.
    """
    # ensure the message is something we need to respond to
    if not message.mentions or client.user not in message.mentions:
        # Ignore messages that did not directly mention or reply to this bot
        return
    elif message.author == client.user:
        # Ignore messages from the bot itself
        return

    # Attempt to determine the category name of the channel where the message was posted, if any
    category_name = None
    channel_name = message.channel.name
    category_name = (
        message.channel.category.name if hasattr(message.channel, "category") else None
    )

    # determine which course this message is related to, based on the category_name
    course_name = None
    for course in courses:
        # if the category name matches the course's category, we have a match
        if "categories" in course and category_name in course["categories"]:
            course_name = course["title"]
            break
    # if no course name yet, try to determine it based on the user's role in Discord
    if not course_name:
        user_roles = [role.name for role in getattr(message.author, "roles", [])]
        for course in courses:
            # get our config settings for roles
            student_role = course.get("roles", {}).get("student")
            admins_role = course.get("roles", {}).get("admins")
            # see whether our config roles match the user's roles
            student_role_match = student_role and student_role in user_roles
            admin_role_match = admins_role and admins_role in user_roles
            # there's a match?
            if student_role_match or admin_role_match:
                course_name = course["title"]
                break

    # ignore messages that do not fall into any course
    if not course_name:
        print(
            f"Message from {message.author.name} in {category_name} / {channel_name} does not match any course."
        )
        return

    # get the OpenAI assistant for this course
    oa_id = None
    for course in courses:
        if course["title"] == course_name:
            oa_config = course.get("openai_assistant", {})
            oa_id = oa_config.get("id", None)
    if not oa_id:
        print(
            f"No OpenAI assistant configured for {course_name} course in {category_name} / {channel_name}."
        )
        return

    # the message is directed to the bot
    print(
        f"Message about {course_name} course in {category_name} / {channel_name} from {message.author.name}"
    )

    # Create a new thread for the user if it doesn't exist
    if openai_threads.get(message.author) is None:
        openai_threads[message.author] = openai_client.beta.threads.create()
    openai_thread_id = openai_threads.get(message.author).id

    # add message to the thread
    print(f"Prompt: {message.content}")
    openai_prompt = openai_client.beta.threads.messages.create(
        thread_id=openai_thread_id,  # this user's thread
        role="user",
        content=message.content,  # what the user wrote
    )
    openai_run = openai_client.beta.threads.runs.create_and_poll(
        thread_id=openai_thread_id,
        assistant_id=oa_id,
        instructions=f"Be respectful to this user and address them as exactly the name, '<@{message.author.id}>'.",
    )
    if openai_run.status == "completed":
        openai_messages = list(
            openai_client.beta.threads.messages.list(
                thread_id=openai_thread_id, run_id=openai_run.id
            )
        )
        # get the first message's content... this is the most recentresponse from OpenAI
        openai_response = openai_messages[0].content[0].text.value
        openai_response = re.sub(r"【.*?】", "", openai_response)
        print(f"Response: {openai_response}")
        # Send the last response back to the Discord channel
        await message.channel.send(openai_response)
    else:
        print(openai_run.status)


# Run the main function if running this file directly.
if __name__ == "__main__":
    asyncio.run(client.start(BOT_TOKEN))
