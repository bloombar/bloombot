#!/usr/bin/env python3

import os
import asyncio
import argparse
from discord_manager import DiscordManager


def main():
    """
    Parse command line arguments to determine which actions to perform.
    """

    parser = argparse.ArgumentParser(description="Discord Channel Manager")

    # discord Auth token (created in Discord Developer Portal)... default to token in environment (or .env file) if any
    parser.add_argument(
        "--token",
        required=False,
        help="Discord bot token; otherwise looks for BOT_TOKEN environment variable or .env file.",
        default=os.getenv("BOT_TOKEN"),
    )

    # list servers
    parser.add_argument(
        "--show-servers",
        action="store_true",
        help="Show all available Discord servers (a.k.a. guilds)",
    )

    # list categories
    parser.add_argument(
        "--show-categories",
        action="store_true",
        help="Show categories in the specified server.",
    )

    # list channels
    parser.add_argument(
        "--show-channels",
        action="store_true",
        help="Show channels in the specified server and optional category.",
    )

    # list users
    parser.add_argument(
        "--show-users",
        action="store_true",
        help="Show users in the specified server and optional category or channel.",
    )

    # select specific server
    parser.add_argument(
        "--server",
        type=lambda x: int(x) if x.isdigit() else x,  # int or string
        help="Select specific Discord server (a.k.a. guild) by ID or name",
    )

    # select specific category
    parser.add_argument(
        "--category",
        type=lambda x: int(x) if x.isdigit() else x,  # int or string,
        help="Select specific category by ID or name",
    )

    # select specific channel
    parser.add_argument(
        "--channel",
        type=lambda x: int(x) if x.isdigit() else x,  # int or string
        help="Select specific channel by ID or name",
    )

    # select specific user
    parser.add_argument(
        "--user",
        type=lambda x: int(x) if x.isdigit() else x,  # int or string
        help="Select specific user by ID or name",
    )

    # select specific role
    parser.add_argument(
        "--role",
        type=lambda x: int(x) if x.isdigit() else x,  # int or string
        help="Select specific role by ID or name",
    )

    # delete specific category
    parser.add_argument(
        "--delete-category",
        type=lambda x: int(x) if x.isdigit() else x,  # int or string
        help="ID of category to delete",
    )

    # delete specific channel
    parser.add_argument(
        "--delete-channel",
        type=lambda x: int(x) if x.isdigit() else x,  # int or string
        help="ID of channel to delete",
    )

    # create specific category
    parser.add_argument(
        "--create-category",
        type=str,
        help="Name of category to create in the specified server.",
    )
    # create specific channel
    parser.add_argument(
        "--create-channel",
        type=str,
        help="Name of channel to create in the specified server and optional category.",
    )

    # parse the command-line arguments
    args = parser.parse_args()

    # check correct command-line argument usage
    if not args.show_servers and not args.server:
        # can't do anything if not listing available servers or selecting a server
        parser.error("No action specified.  Add --show-servers or --server [server_id]")
    if (
        args.category or args.show_categories or args.show_channels
    ) and not args.server:
        # can't show categories or channels without a server
        parser.error("No server specified.  Add --server [server_id]")

    # instantate the Discord client
    client = DiscordManager(
        token=args.token,
        event_loop=False,
        show_guilds=args.show_servers,
        show_categories=args.show_categories,
        show_channels=args.show_channels,
        show_users=args.show_users,
        guild_id=args.server,
        category_id=args.category,
        channel_id=args.channel,
        user_id=args.user,
        role_id=args.role,
        delete_category=args.delete_category,
        delete_channel=args.delete_channel,
        create_category=args.create_category,
        create_channel=args.create_channel,
    )
    # start the bot
    asyncio.run(client.start(args.token))


if __name__ == "__main__":
    main()
