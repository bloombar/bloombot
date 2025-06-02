#!/usr/bin/env python3

"""
Discord bot that responds to incoming messages.
"""

import os
import asyncio
from dotenv import load_dotenv
from discord_manager import DiscordManager
from openai import OpenAI

load_dotenv()  # load environment variables from .env file

SERVER_NAME = "Knowledge Kitchen"  # change to whatever your server name or ID is
BOT_TOKEN = os.getenv("BOT_TOKEN")  # from .env file
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")  # from .env file
OPENAI_ASSISTANT_ID = os.getenv("OPENAI_ASSISTANT_ID")  # from .env file

openai_client = OpenAI()
openai_threads = {}  # will hold threads for each user

# create or open an OpenAI Assistant
if OPENAI_ASSISTANT_ID:
    # if we have an assistant ID, use it to get the assistant
    openai_assistant = openai_client.beta.assistants.retrieve(
        assistant_id=OPENAI_ASSISTANT_ID
    )
else:
    openai_assistant = openai_client.beta.assistants.create(
        name="Assistant to the Professor",
        instructions="You are a personal assistant to Amos Bloomberg, a professor of Computer Science at New York University teaching an Intro to Programming and a Web Design course in Summer 2025. Help answer questions about course material and the schedule and syllabus.",
        tools=[{"type": "code_interpreter"}],
        model="gpt-4o",
    )


# start up bot set to create a category, if not yet exists
client = DiscordManager(guild_id=SERVER_NAME, event_loop=True)


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
    # Ignore messages from the bot itself
    if message.author == client.user:
        return

    # Ignore messages that did not directly mention this bot
    if not message.mentions or client.user not in message.mentions:
        return

    # Create a new thread for the user if it doesn't exist
    if openai_threads.get(message.author) is None:
        openai_threads[message.author] = openai_client.beta.threads.create()
    openai_thread_id = openai_threads.get(message.author).id

    # add message ot the thread
    print(f"Prompt: {message.content}")
    openai_prompt = openai_client.beta.threads.messages.create(
        thread_id=openai_thread_id,  # this user's thread
        role="user",
        content=message.content,  # what the user wrote
    )
    openai_run = openai_client.beta.threads.runs.create_and_poll(
        thread_id=openai_thread_id,
        assistant_id=openai_assistant.id,
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
        print(f"Response: {openai_response}")
        # Send the last response back to the Discord channel
        await message.channel.send(openai_response)
    else:
        print(openai_run.status)


# Run the main function if running this file directly.
if __name__ == "__main__":
    asyncio.run(client.start(BOT_TOKEN))
