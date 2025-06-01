#!/usr/bin/env python3

"""
Create Discord channels for each student in the roster CSV file.
"""

import os
import asyncio
from dotenv import load_dotenv
import discord
from discord_manager import DiscordManager
import csv

load_dotenv()  # load environment variables from .env file

# SETTINGS
ROSTER_FILE = "results/wd-result.csv"  # path to the CSV file containing student data
ROSTER_START_ROW = 1  # row number to start reading from in the CSV file (1-indexed)
ADMINS_ROLE = "admins-wd-su25"
STUDENTS_ROLE = "students-wd-su25"  # role for students, if you want to use it
SERVER_NAME = "Knowledge Kitchen"  # change to whatever your server name or ID is
CATEGORY_NAME = "WEB DESIGN - STUDENTS 01"  # change to whatever your category name is
BOT_TOKEN = os.getenv("BOT_TOKEN")  # from .env file


# start up bot set to create a category, if not yet exists
client = DiscordManager(
    guild_id=SERVER_NAME, event_loop=True, create_category=CATEGORY_NAME
)


# set up bot actions... this will override its default on_ready() routine.
@client.event
async def on_ready():
    """
    What to do when bot is connected and ready to use.
    """
    print(f"Logged in as: {client.user.name} (ID: {client.user.id})")
    await create_category()
    await create_channels()
    await client.stop()


async def create_category():
    """
    Create a category in the server if it does not already exist.
    """
    print("Creating category...")
    # await client.wait_until_ready()  # Ensure the client is ready before proceeding
    guild_id = client.get_server_id(server_name=SERVER_NAME)
    if not guild_id:
        print("Server not found.")
        await client.stop()
        return
    print(f"Got the server ID {guild_id} for {SERVER_NAME}")
    # Create the category
    await client.add_category(guild_id=guild_id, category_name=CATEGORY_NAME)
    print(f"Created category: {CATEGORY_NAME}")


async def create_channels():
    """
    Create a channel for each student in the student roster CSV file.
    """

    print("Creating channels...")
    # select the server
    guild_id = client.get_server_id(server_name=SERVER_NAME)
    if not guild_id:
        print("Server not found.")
        await client.stop()
        return
    guild = client.get_guild(guild_id)

    # open the roster file
    with open(ROSTER_FILE, newline="", encoding="utf-8") as csvfile:
        reader = csv.DictReader(csvfile)
        for idx, row in enumerate(reader, start=1):
            # start reading from the specified row
            if idx < ROSTER_START_ROW - 1:  # 1-indexed
                continue
            email = row.get("Email", "")
            if "@" in email:
                channel_name = email.split("@")[0]
                try:
                    category_id = client.get_category_id(
                        guild_id=guild_id, category_name=CATEGORY_NAME
                    )
                    member_name = row.get("Discord", channel_name)
                    member_id = client.get_user_id(
                        guild_id=guild_id,
                        user_name=member_name,
                        match_display_names=True,
                    )
                    member = discord.utils.get(guild.members, id=member_id)
                    admins_role_id = client.get_role_id(
                        guild_id=guild_id, role_name=ADMINS_ROLE
                    )
                    admins_role = (
                        guild.get_role(admins_role_id) if admins_role_id else None
                    )
                    overwrites = {
                        guild.default_role: discord.PermissionOverwrite(
                            read_messages=False
                        ),
                    }
                    if member:
                        overwrites[member] = discord.PermissionOverwrite(
                            read_messages=True, send_messages=True
                        )
                    else:
                        print(f"User @{member_name} not found, no permissions set.")
                    if admins_role_id:
                        overwrites[admins_role] = discord.PermissionOverwrite(
                            read_messages=True, send_messages=True
                        )
                    else:
                        print(f"Role @{ADMINS_ROLE} not found, no permissions set.")

                    await client.add_channel(
                        guild_id=guild_id,
                        channel_name=channel_name,
                        category_id=category_id,
                    )
                    print(f"Created channel: {channel_name}")
                    channel_id = client.get_channel_id(
                        guild_id=guild_id,
                        channel_name=channel_name,
                        category_id=category_id,
                    )
                    channel = guild.get_channel(channel_id)
                    if channel:
                        print(
                            f"Modifying permissions on #{channel_name} (ID: {channel.id})..."
                        )
                        await channel.edit(overwrites=overwrites)

                except Exception as e:
                    print(f"Failed to create channel {channel_name}: {e}")


# Run the main function if running this file directly.
if __name__ == "__main__":
    asyncio.run(client.start(BOT_TOKEN))
