#!/usr/bin/env python3

"""
Create Discord channels for each student in the roster CSV file.
"""

import os
import asyncio
from dotenv import load_dotenv
from discord_manager import DiscordManager

load_dotenv()  # load environment variables from .env file


def main():
    # instantate the Discord client
    client = DiscordManager(
        guild_id="Knowledge Kitchen", show_categories=True, event_loop=False
    )
    # start the bot
    asyncio.run(client.start(os.getenv("BOT_TOKEN")))


# Run the main function if running this file directly.
if __name__ == "__main__":
    main()
