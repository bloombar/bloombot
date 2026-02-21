#!/usr/bin/env python3

"""
Discord bot that responds to incoming messages.
"""

import os
import re
import asyncio
from datetime import datetime
from pathlib import Path
import yaml
from dotenv import load_dotenv
import logging

import discord

import openai
from openai import OpenAI

from discord_manager import DiscordManager
from models.message import Message
from models.user import User

load_dotenv()  # load environment variables from .env file

logger = logging.getLogger(__name__)
program_file = os.path.basename(__file__)  # the name of this python script
program_file_base = os.path.splitext(program_file)[0]  # remove extension
logs_dir = os.getenv("LOGS_DIR", "./logs")
logs_level = os.getenv("LOG_LEVEL", "INFO").upper()
# Ensure logs directory exists
logs_path = Path(logs_dir).expanduser()
logs_path.mkdir(parents=True, exist_ok=True)
logs_dir = str(logs_path)
# logging.basicConfig(level=logging.INFO)  # set up logging
logging.basicConfig(
    filename=f"{logs_dir}/{program_file_base}.log",
    encoding="utf-8",
    level=logs_level,
    format="%(asctime)s %(levelname)s:%(message)s",
)

BOT_TOKEN = os.getenv("BOT_TOKEN")  # from .env file
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")  # from .env file
CONFIG_FILE = Path("bot_config.yml").resolve()  # path to the configuration file
OPENAI_DEFAULT_MODEL = "gpt-4o"  # can be overriden in config file
OPENAI_DEFAULT_MAX_REQUEST_PER_DAY = 10  # can be overriden in config file

# create OpenAI client
openai_client = OpenAI()
openai_conversations = {}  # will hold separate threads keyed by username
openai_num_requests = {}  # will track # requests from each user per day

# load the config data from file
with open(CONFIG_FILE, encoding="utf-8", mode="r") as f:
    config = yaml.safe_load(f)
    # get server name
    SERVER_NAME = config["server"]["name"]
    courses = config["server"]["courses"]

    # get an OpenAI Responses Prompt for each course
    # for course in courses:
    #     # get existing OpenAI responses prompt... this must have been set up in OpenAI dev portal
    #     oa_config = course.get("openai_assistant", {})
    #     # retrieve or create the response object
    #     oa_config["instance"] = openai_client.responses.create(
    #         model=oa_config.get("model", OPENAI_DEFAULT_MODEL),
    #         prompt={
    #             "id": oa_config.get("prompt_id", None),  # get prompt ID from config
    #         },
    #         input=[],
    #         tools=[
    #             {
    #                 "type": "file_search",
    #                 "vector_store_ids": [oa_config.get("vector_store_id", None)],
    #             }
    #         ],
    #         max_output_tokens=2048,
    #         store=True,
    #     )
    #     logger.info(
    #         f"Loaded OpenAI Prompt ID {oa_config['instance'].id} for course '{course['title']}'"
    #     )
    #     logger.debug(oa_config)


# start up bot set to create a category, if not yet exists
client = DiscordManager(guild_id=config["server"]["name"], event_loop=True)


# set up bot actions... this will override its default on_ready() routine.
@client.event
async def on_ready():
    """
    Bot is connected to Discord and ready to use.
    """
    logger.info(f"Logged into Discord as: @{client.user.name} (ID: {client.user.id})")


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
    admins_role = None
    # in case of error, we may message the admins for their attention

    for course in courses:
        # if the category name matches the course's category, we have a match
        if "categories" in course and category_name in course["categories"]:
            course_name = course["title"]
            admins_role = course.get("roles", {}).get("admins")
            break
    # if no course name yet, try to determine it based on the user's role in Discord
    if not course_name:
        user_roles = [role.name for role in getattr(message.author, "roles", [])]
        for course in courses:
            # get our config settings for roles
            this_course_student_role = course.get("roles", {}).get("student")
            this_course_admins_role = course.get("roles", {}).get("admins")
            # see whether our config roles match the user's roles
            student_role_match = (
                this_course_student_role and this_course_student_role in user_roles
            )
            admin_role_match = (
                this_course_admins_role and this_course_admins_role in user_roles
            )
            # there's a match?
            if student_role_match or admin_role_match:
                course_name = course["title"]
                admins_role = course.get("roles", {}).get("admins")
                break

    # ignore messages that do not fall into any course
    if not course_name:
        logger.info(
            f"Message from @{message.author.name} ({message.author.id}) in '{category_name}'#{channel_name} does not match any course."
        )
        return

    # get the OpenAI Responses API Prompt for this course
    oa_prompt_id = None
    for course in courses:
        if course["title"] == course_name:
            oa_config = course.get("openai_assistant", {})
            oa_prompt_id = oa_config.get("prompt_id", None)
            logger.info(
                f"Using OpenAI Prompt ID: {oa_prompt_id} for course '{course_name}'"
            )
    if not oa_prompt_id:
        logger.warning(
            f"No OpenAI Prompt configured for '{course_name}' course in '{category_name}'#{channel_name}."
        )
        return

    # check the user's stats to ensure they have not exceeded the limit of requests
    user_stats = openai_num_requests.get(
        message.author,
        {
            "num_requests": 0,
            "last_response_date": None,
        },
    )
    # if the user has made more than 10 requests today, ignore the message
    # get the request limit for this course from config
    request_limit = oa_config.get("limits", {}).get(
        "max_requests_per_day", OPENAI_DEFAULT_MAX_REQUEST_PER_DAY
    )
    logger.info(
        f"User @{message.author.name} ({message.author.id}) has made {user_stats['num_requests']} requests today (limit: {request_limit})."
    )
    rate_limit_message = ""
    if user_stats["num_requests"] == request_limit:
        rate_limit_message = f"You have reached the maximum number of responses for today. See {course_name} admins for help."
    if user_stats["num_requests"] > request_limit:
        logger.info(
            f"User @{message.author.name} ({message.author.id}) has exceeded the daily request limit ({request_limit})."
        )
        return

    # the message is directed to the bot
    logger.info(
        f"Message about '{course_name}' course in '{category_name}'#{channel_name} from @{message.author.name} ({message.author.id})"
    )

    # log incoming message into database
    try:
        # get the user with this message.author.id from the User model
        user, created = User.get_or_create(
            discord_id=message.author.id,
            discord_username=message.author.name,
        )
        # store this message in database
        message_record = Message.create(
            content=message.content,
            category=category_name,
            channel=channel_name,
            direction="from",
            user=user,
        )
    except Exception as e:
        logger.error(f"Failed to log message: {e}")

    # Create a new Conversation for the user if it doesn't exist
    if openai_conversations.get(message.author) is None:
        # create new conversation
        openai_conversations[message.author] = openai_client.conversations.create(
            items=[
                {
                    "role": "user",
                    "content": f"My name is {message.author.name} (user id <@{message.author.id}>) and I am a student in the {course_name} course.",
                }
            ],
            metadata={"user_id": f"<@{message.author.id}>"},
        )
        logger.debug(
            f"Creating new OpenAI Conversation ID {openai_conversations.get(message.author).id} for user @{message.author.name} ({message.author.id})"
        )
    else:
        # found existing conversation
        logger.debug(
            f"Reusing existing OpenAI Conversation ID {openai_conversations.get(message.author).id} for user @{message.author.name} ({message.author.id})"
        )
    # stablish the id of the conversation
    openai_conversation_id = openai_conversations.get(message.author).id
    logger.info(
        f"Using OpenAI Conversation ID: {openai_conversation_id} for user @{message.author.name} ({message.author.id})"
    )

    # add message to the thread
    logger.info(
        f"Prompt from @{message.author.name} ({message.author.id}): {message.content}"
    )

    # replace the bot's id with username in the message to help the model understand
    message_content = re.sub(f"<@!?{client.user.id}>", "@Bloombot", message.content)

    is_response = False  # assume the worst
    try:
        # try to get response from OpenAI API
        openai_response = openai_client.responses.create(
            model=oa_config.get("model", OPENAI_DEFAULT_MODEL),
            prompt={
                "id": oa_config.get("prompt_id", None),  # get prompt ID from config
            },
            input=[{"role": "user", "content": message_content}],
            conversation=openai_conversation_id,
            tools=[
                {
                    "type": "file_search",
                    "vector_store_ids": [oa_config.get("vector_store_id", None)],
                }
            ],
            max_output_tokens=2048,
            store=True,
        )

        # extract the text from the response
        openai_response = openai_response.output_text.strip()
        is_response = True  # flag it for later

    except Exception as e:
        logger.error(f"Error from OpenAI API: {e}")
        openai_response = f"Sorry, I can't respond intelligently right now. Please see {course_name} admins for help."

    # get first output response
    logger.info(
        f"OpenAI response to @{message.author.name} (ID: {message.author.id}): {openai_response}"
    )

    # clean up the response by removing any 【source】 references
    openai_response = re.sub(r"【.*?】", "", openai_response)

    # if we have a rate limit message, prepend it to the response
    if rate_limit_message:
        openai_response = f"{rate_limit_message} {openai_response}"
    logger.info(f"Response to @{message.author.id}: {openai_response}")
    # Send the last response back to the Discord channel
    await message.channel.send(openai_response)

    # log outgoing message into database
    try:
        # get the user with this message.author.id from the User model
        user, created = User.get_or_create(
            discord_id=message.author.id,
            discord_username=message.author.name,
        )
        # store this message in database
        message_record = Message.create(
            content=openai_response,
            category=category_name,
            channel=channel_name,
            direction="to",
            user=user,
        )
    except Exception as e:
        logger.error(f"Failed to log message: {e}")

    # update the user's stats to reflect this new request
    today = datetime.now().strftime("%Y-%m-%d")
    if user_stats["last_response_date"] != today:
        user_stats["num_requests"] = 1
    else:
        user_stats["num_requests"] += 1
    user_stats["last_response_date"] = today
    openai_num_requests[message.author] = user_stats

    # log
    logger.info(
        f"{message.author.name} ({message.author.id}) has made {user_stats['num_requests']} requests."
    )


# Run the main function if running this file directly.
if __name__ == "__main__":
    asyncio.run(client.start(BOT_TOKEN))
