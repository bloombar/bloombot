#!/usr/bin/env python3

import os
import argparse
import asyncio
import discord
from dotenv import load_dotenv

load_dotenv()  # load environment variables from .env file


class GuildFetcher(discord.Client):
    def __init__(
        self,
        token=None,
        show_guilds=False,
        guild_id=None,
        show_categories=False,
        category_id=None,
        show_channels=False,
        channel_id=None,
        delete_category=None,
        delete_channel=None,
        **kwargs,
    ):

        # Set intents to allow managing channels
        intents = discord.Intents.default()
        intents.guilds = True
        # intents.guild_messages = True
        # intents.guild_reactions = True
        # intents.members = True
        # intents.message_content = True
        super().__init__(intents=intents)

        # store instance properties
        self.token = token
        self.show_guilds = show_guilds
        self.guild_id = guild_id
        self.category_id = category_id
        self.show_categories = show_categories
        self.show_channels = show_channels
        self.channel_id = channel_id
        self.delete_category = delete_category
        self.delete_channel = delete_channel

    def get_server_id(self, sever_name):
        """
        Get the server ID by name.
        """
        for guild in self.guilds:
            if guild.name.lower().strip() == sever_name.lower().strip():
                return guild.id
        return None

    def get_category_id(self, guild_id, category_name):
        """
        Get the category ID by name in a specific server/guild.
        """
        guild = self.get_guild(int(guild_id))
        if not guild:
            return None
        for category in guild.categories:
            if category.name.lower().strip() == category_name.lower().strip():
                return category.id
        return None

    def get_channel_id(
        self,
        guild_id,
        channel_name,
        category_id=None,
    ):
        """
        Get the channel ID by name in a specific server/guild and optional category.
        """
        guild = self.get_guild(int(guild_id))
        if not guild:
            return None
        if category_id:
            # specific category specified
            category = guild.get_channel(int(category_id))
            if not category or not isinstance(category, discord.CategoryChannel):
                return None
            for channel in category.channels:
                if channel.name.lower().strip() == channel_name.lower().strip():
                    return channel.id
        else:
            # no category specified
            for channel in guild.channels:
                if channel.name.lower().strip() == channel_name.lower().strip():
                    return channel.id
        return None

    def print_guilds(self):
        """
        Print a list of the available servers (a.k.a. guilds).
        """
        # show the available servers (a.k.a. guilds)
        print(f"{'SERVERS/GUILDS':^67}")
        print(f"{'':-^67}")
        print(f"| {'Server Name':<30} | {'ID':<30} |")
        print(f"| {'':-^30} | {'':-^30} |")
        for i, guild in enumerate(self.guilds, start=1):
            print(f"| {guild.name:<30} | {guild.id:<30} |")
        print(f"{'':-^67}")
        print()

    def print_categories(self, guild_id):
        """
        Print a list of the available categories in the specified guild.
        """
        guild = self.get_guild(int(guild_id))
        # guild = discord.utils.get(self.guilds, id=int(guild_id))
        if not guild:
            print(f"Guild ID {guild_id} not found.")
            return

        print(f"{guild.name.upper():^67}")
        print(f"{'':-^67}")
        # print(f"| {'':-^30} | {'':-^30} |")
        print(f"| {'Category Name':<30} | {'ID':<30} |")
        print(f"| {'':-^30} | {'':-^30} |")
        for category in guild.categories:
            print(f"| {category.name:<30} | {category.id:<30} |")
        print(f"{'':-^67}")
        print()

        if not guild.categories:
            print("No categories in this server.")

    def print_channels(self, guild_id, category_id=None):
        """
        Print a list of channels in the specified guild, optionally filtered by category.
        """
        guild = self.get_guild(int(guild_id))
        if not guild:
            print(f"Guild ID {guild_id} not found.")
            return

        if category_id:
            # specific category specified
            category = guild.get_channel(
                int(category_id)
            )  # get category details, if any

            subheading = f"{guild.name.upper()} / '{category.name.upper()}'"
            print(f"{subheading:^67}")
            print(f"{'':-^67}")
            print(f"| {'Channel Name':<30} | {'ID':<30} |")
            print(f"| {'':-^30} | {'':-^30} |")

            # iterate through all channels in the specified category
            if category and isinstance(category, discord.CategoryChannel):
                for channel in category.channels:
                    print(f"| {channel.name:<30} | {channel.id:<30} |")
            else:
                print("Category not found or invalid.")
        else:
            # no category specified
            print(f"{guild.name.upper():^67}")
            print(f"{'':-^67}")
            print(f"| {'Channel Name':<30} | {'ID':<30} |")
            print(f"| {'':-^30} | {'':-^30} |")

            # iterate through all channels in the server/guild
            for channel in guild.channels:
                if isinstance(channel, discord.TextChannel) or isinstance(
                    channel, discord.VoiceChannel
                ):
                    print(f"| {channel.name:<30} | {channel.id:<30} |")

        print(f"{'':-^67}")
        print()

    async def remove_category(self, guild_id, category_id, delete_channels=True):
        """
        Delete a category in the specified guild, optionally deleting its channels.
        """
        guild = self.get_guild(int(guild_id))
        if not guild:
            print(f"Guild ID {guild_id} not found.")
            return

        # Check if the bot has permission to manage channels in this guild
        # me = guild.me
        # print(me.guild_permissions)
        # if not me.guild_permissions.manage_channels:
        #     print(
        #         "Error: Bot does not have permission to manage channels in this guild."
        #     )
        #     return

        category = guild.get_channel(int(category_id))
        if not category or not isinstance(category, discord.CategoryChannel):
            print(f"Category ID {category_id} not found.")
            return

        print(f"Deleting category '{category.name}'... from guild '{guild.name}'...")

        if delete_channels:
            # delete all channels in the category
            for i, channel in enumerate(category.channels):
                print(f"Deleting channel '{channel.name}'...")
                await channel.delete()
        print(f"Deleting category '{category.name}'...")
        await category.delete()
        print(f"Category '{category.name}' (ID: {category.id}) deleted.")

    async def on_ready(self):
        if self.guild_id:
            # if a specific server (a.k.a. guild) has been specified
            guild = self.get_guild(int(self.guild_id))
            print(
                f"\nLogged into Discord server '{guild.name}' (ID: {guild.id}) as user '{self.user.name}' (ID: {self.user.id})"
            )
        else:
            # if no specific server has been specified
            print(
                f"\nLogged into Discord as user '{self.user.name}' (ID: {self.user.id})"
            )
        print()

        if self.show_guilds:
            # print the available guilds (a.k.a. servers)
            self.print_guilds()
        if self.show_categories and self.guild_id:
            # print the available categories in the specified guild
            self.print_categories(self.guild_id)
        if self.show_channels and self.guild_id:
            # print the available channels in the specified guild
            self.print_channels(self.guild_id, self.category_id)
        if self.delete_category and self.guild_id:
            # delete the specified category in the specified guild, including all channels
            await self.remove_category(self.guild_id, self.delete_category)

        # close bot nicely
        await self.http.close()  # avoid warning about unclosed connections
        await self.close()


def main():
    parser = argparse.ArgumentParser(description="Discord Guild/Category Fetcher")
    # discord Auth token (created in Discord Developer Portal)... default to token in environment (or .env file) if any
    parser.add_argument(
        "--token",
        required=False,
        help="Discord bot token (created in Discord Developer Portal - https://discord.com/developers/)",
        default=os.getenv("BOT_TOKEN"),
    )
    # servers
    parser.add_argument(
        "--show-servers",
        action="store_true",
        help="Show all available Discord servers (a.k.a. guilds)",
    )
    parser.add_argument("--server", type=int, help="Discord server (a.k.a. guild) ID")

    # categories
    parser.add_argument(
        "--show-categories",
        action="store_true",
        help="Show categories in the specified server.",
    )
    parser.add_argument("--category", type=int, help="Category ID")

    # channels
    # categories
    parser.add_argument(
        "--show-channels",
        action="store_true",
        help="Show channels in the specified server and optional category.",
    )
    parser.add_argument("--channel", type=int, help="Channel ID")

    # delete category
    parser.add_argument("--delete-category", type=int, help="ID of category to delete")
    parser.add_argument("--delete-channel", type=int, help="ID of channel to delete")

    args = parser.parse_args()

    if not args.show_servers and not args.server:
        # can't do anything if not listing available servers or selecting a server
        parser.error("No action specified.  Add --show-servers or --server [server_id]")
    if (
        args.category or args.show_categories or args.show_channels
    ) and not args.server:
        # can't show categories or channels without a server
        parser.error("No server specified.  Add --server [server_id]")

    client = GuildFetcher(
        token=args.token,
        show_guilds=args.show_servers,
        guild_id=args.server,
        show_categories=args.show_categories,
        category_id=args.category,
        show_channels=args.show_channels,
        channel_id=args.channel,
        delete_category=args.delete_category,
        delete_channel=args.delete_channel,
    )
    # start the bot
    asyncio.run(client.start(args.token))


if __name__ == "__main__":
    main()
