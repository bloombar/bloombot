#!/usr/bin/env python3

"""
Create Discord channels for each student in a roster CSV file.
Creates a category to house the student channels.
"""

import os
import csv
import asyncio
from pathlib import Path
import yaml
from dotenv import load_dotenv
import discord
from discord_manager import DiscordManager

load_dotenv()  # load environment variables from .env file

# SETTINGS
CONFIG_FILE = Path("bot_config.yml").resolve()  # path to the configuration file
BOT_TOKEN = os.getenv("BOT_TOKEN")  # from .env file

# load the data in bot_config.yml into a Dictionary
SERVER_NAME = ""
config = {}
with open(CONFIG_FILE, encoding="utf-8", mode="r") as f:
    # get config from YAML file
    config = yaml.safe_load(f)
    # get server name
    SERVER_NAME = config["server"]["name"]

# start up bot set to create a category, if not yet exists
client = DiscordManager(guild_id=SERVER_NAME, event_loop=True)


# set up bot actions... this will override its default on_ready() routine.
@client.event
async def on_ready():
    """
    What to do when bot is connected and ready to use.
    """
    print(f"Logged into Discord as: @{client.user.name} (ID: {client.user.id})")

    # get array of courses from config data
    courses = config["server"]["courses"]
    if len(courses) == 0:
        raise RuntimeError(f"No courses found in config for server '{SERVER_NAME}'.")

    for course in courses:
        course_title = course["title"]
        course_file_prefix = course["file_prefix"]
        students_role = course["roles"]["students"]
        admins_role = course["roles"]["admins"]

        # determine the roster file name based on the course file prefix in the config
        roster_file = f"results/{course_file_prefix}-result.csv"

        if not course_file_prefix and not admins_role and not students_role:
            raise RuntimeError(
                f"Error loading config data for course '{course_title}'."
            )

        roster_file = Path(roster_file).resolve()  # path to the roster CSV file

        print(
            f"""
        Config:
            ROSTER_FILE: {roster_file}
            ADMINS_ROLE: {admins_role}
            STUDENTS_ROLE: {students_role}
        """
        )

        # iterate through each category and create it and its child channels
        for category_config in course.get("categories", []):
            # support both plain strings and dicts with an optional channels list
            if isinstance(category_config, str):
                category_name = category_config
                channels_config = []
            else:
                category_name = category_config["name"]
                channels_config = category_config.get("channels", [])

            print(
                f"Processing category '{category_name}' for course '{course_title}'..."
            )

            # create the category
            await create_category(
                SERVER_NAME, category_name, admins_role, students_role
            )

            # set its permissions
            await set_category_permissions(
                SERVER_NAME, category_name, admins_role, students_role
            )

            # create channels after permissions are set so they inherit correctly
            if channels_config:
                await create_category_channels(
                    SERVER_NAME, category_name, channels_config, admins_role, students_role
                )
            else:
                await create_temp_channel(SERVER_NAME, category_name)

    # done!
    await client.stop()


async def create_category(server_name, category_name, admins_role, students_role):
    """
    Create a category in the server if it does not already exist.
    """
    print(f"Creating category '{category_name}' in server '{server_name}'...")
    guild_id = client.get_server_id(server_name=server_name)
    if not guild_id:
        print("Server not found.")
        await client.stop()
        return
    print(f"Got the server ID {guild_id} for {server_name}")
    await client.add_category(guild_id=guild_id, category_name=category_name)
    print(f"Created category: {category_name}")


async def create_temp_channel(server_name, category_name):
    """
    Create a placeholder 'temp' channel so the category is visible to users.
    No explicit permissions are set — the channel inherits from the category
    automatically via Discord's default sync behavior.
    """
    guild_id = client.get_server_id(server_name=server_name)
    if not guild_id:
        print("Server not found.")
        return
    category_id = client.get_category_id(guild_id=guild_id, category_name=category_name)
    if not category_id:
        print(f"Category '{category_name}' not found.")
        return

    channel_name = "temp"
    is_new = client.get_channel_id(
        guild_id=guild_id, channel_name=channel_name, category_id=category_id
    ) is None

    if is_new:
        print(f"Creating placeholder channel '{channel_name}' in category '{category_name}'...")
        await client.add_channel(
            guild_id=guild_id, channel_name=channel_name, category_id=category_id
        )
    else:
        print(f"Placeholder channel '{channel_name}' already exists in '{category_name}', skipping.")

    channel_id = client.get_channel_id(
        guild_id=guild_id, channel_name=channel_name, category_id=category_id
    )
    if channel_id:
        channel = client.get_channel(channel_id)
        if channel:
            await channel.edit(sync_permissions=True)
            print(f"Synced permissions on '{channel_name}' with category '{category_name}'.")
            if is_new:
                await channel.send(f"Category '{category_name}' auto-created.")
                print(f"Posted auto-create message in '{channel_name}'.")
        else:
            print(f"Channel object not found for id {channel_id}.")
    else:
        print(f"No channel id found for '{channel_name}'.")


async def set_category_permissions(
    server_name, category_name, admins_role, students_role
):
    """
    Set permissions for the category to allow admins and students roles access.
    """
    print(
        f"Setting permissions for category '{category_name}' in server '{server_name}'..."
    )
    guild_id = client.get_server_id(server_name=server_name)
    if not guild_id:
        print("Server not found.")
        await client.stop()
        return
    guild = client.get_guild(guild_id)

    category_id = client.get_category_id(guild_id=guild_id, category_name=category_name)
    category = guild.get_channel(category_id)
    if not category:
        print(f"Category '{category_name}' not found.")
        return

    admins_role_id = client.get_role_id(guild_id=guild_id, role_name=admins_role)
    students_role_id = client.get_role_id(guild_id=guild_id, role_name=students_role)

    overwrites = {
        guild.default_role: discord.PermissionOverwrite(read_messages=False),
    }
    if admins_role_id:
        admins_role_obj = guild.get_role(admins_role_id)
        overwrites[admins_role_obj] = discord.PermissionOverwrite(
            read_messages=True, send_messages=True
        )
    if students_role_id:
        students_role_obj = guild.get_role(students_role_id)
        overwrites[students_role_obj] = discord.PermissionOverwrite(
            read_messages=True, send_messages=True
        )

    print(f"Modifying permissions on category '{category_name}'...")
    await category.edit(overwrites=overwrites)


async def create_category_channels(
    server_name, category_name, channels_config, admins_role, students_role
):
    """
    Create named channels within a category with per-channel permission overrides.
    Default channels sync permissions from the category (both roles can access).
    Channels with admins_only: true are restricted to the admins role only.
    """
    print(
        f"Creating {len(channels_config)} channel(s) in category '{category_name}'..."
    )
    guild_id = client.get_server_id(server_name=server_name)
    if not guild_id:
        print("Server not found.")
        return
    guild = client.get_guild(guild_id)
    category_id = client.get_category_id(guild_id=guild_id, category_name=category_name)
    admins_role_id = client.get_role_id(guild_id=guild_id, role_name=admins_role)
    admins_role_obj = guild.get_role(admins_role_id) if admins_role_id else None

    for channel_config in channels_config:
        channel_name = channel_config["name"]
        admins_only = channel_config.get("admins_only", False)

        is_new = client.get_channel_id(
            guild_id=guild_id, channel_name=channel_name, category_id=category_id
        ) is None

        if is_new:
            await client.add_channel(
                guild_id=guild_id, channel_name=channel_name, category_id=category_id
            )
            print(f"Created channel: {channel_name}")
        else:
            print(f"Channel '{channel_name}' already exists, updating permissions.")

        if admins_only:
            channel_id = client.get_channel_id(
                guild_id=guild_id, channel_name=channel_name, category_id=category_id
            )
            channel = client.get_channel(channel_id)
            if channel:
                overwrites = {
                    guild.default_role: discord.PermissionOverwrite(read_messages=False),
                }
                if admins_role_obj:
                    overwrites[admins_role_obj] = discord.PermissionOverwrite(
                        read_messages=True, send_messages=True
                    )
                try:
                    await channel.edit(overwrites=overwrites)
                    print(f"Set admins-only permissions on channel '{channel_name}'.")
                    if not is_new:
                        await channel.send("Permissions on this channel have been updated.")
                except Exception as e:
                    print(f"Failed to set permissions on channel '{channel_name}': {e}")


# Run the main function if running this file directly.
if __name__ == "__main__":
    client.run(BOT_TOKEN)
