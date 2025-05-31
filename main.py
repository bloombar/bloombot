#!/usr/bin/env python3

import os
import argparse
import asyncio
import discord
from dotenv import load_dotenv

load_dotenv()  # load environment variables from .env file


class DiscordManager(discord.Client):
    """
    A Discord client for managing servers (a.k.a. guilds), categories, and channels.
    Add, remove, delete, and list Discord servers, categories, and channels.
    Requires a Discord bot token as an environment variable, .env file, or command line argument.
    """

    def __init__(
        self,
        token=None,
        show_guilds=False,
        show_categories=False,
        show_channels=False,
        show_users=False,
        guild_id=None,
        category_id=None,
        channel_id=None,
        user_id=None,
        role_id=None,
        delete_category=None,
        delete_channel=None,
        create_category=None,
        create_channel=None,
        **kwargs,
    ):
        """
        Instantiate the Discord client.
        """

        # Set intents to allow managing channels
        intents = discord.Intents.default()
        intents.guilds = True
        # intents.guild_messages = True
        # intents.guild_reactions = True
        intents.members = True  # requires SERVER MEMBERS INTENT permission in Discord Developer Portalf
        intents.message_content = True  # requires MESSAGE CONTENT INTENT permission in Discord Developer Portalf
        super().__init__(intents=intents)

        # store instance properties from arguments
        self.token = token
        self.show_guilds = show_guilds
        self.show_categories = show_categories
        self.show_channels = show_channels
        self.show_users = show_users
        self.guild_id = guild_id
        self.category_id = category_id
        self.channel_id = channel_id
        self.user_id = user_id
        self.role_id = role_id
        self.delete_category = delete_category
        self.delete_channel = delete_channel
        self.create_category = create_category
        self.create_channel = create_channel

    def fix_ids(self):
        """
        Fix any server, category, or channel IDs that were specified as string names for convenience.
        """
        # get ids from string names, if necessary... ultimately we need ids as integers or NoneTypes.
        self.guild_id = (
            self.guild_id
            if isinstance(self.guild_id, int) or not self.guild_id
            else self.get_server_id(self.guild_id)
        )
        self.category_id = (
            self.category_id
            if isinstance(self.category_id, int) or not self.category_id
            else self.get_category_id(self.guild_id, self.category_id)
        )
        self.channel_id = (
            self.channel_id
            if isinstance(self.channel_id, int) or not self.channel_id
            else self.get_channel_id(self.guild_id, self.channel_id, self.category_id)
        )
        self.delete_category = (
            self.delete_category
            if isinstance(self.delete_category, int) or not self.delete_category
            else self.get_category_id(self.guild_id, self.delete_category)
        )
        self.delete_channel = (
            self.delete_channel
            if isinstance(self.delete_channel, int) or not self.delete_channel
            else self.get_channel_id(
                self.guild_id, self.delete_channel, self.category_id
            )
        )
        self.user_id = (
            self.user_id
            if isinstance(self.user_id, int) or not self.user_id
            else self.get_user_id(self.guild_id, self.user_id)
        )
        self.role_id = (
            self.role_id
            if isinstance(self.role_id, int) or not self.role_id
            else self.get_role_id(self.guild_id, self.role_id)
        )

    def get_server_id(self, server_name):
        """
        Get the server ID by name.
        """
        for guild in self.guilds:
            if guild.name.lower().strip() == server_name.lower().strip():
                return guild.id
            else:
                print(f"Server '{server_name}' not {guild.name}")
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

    def get_user_id(self, guild_id, user_name):
        """
        Get the user ID by name.
        """
        guild = self.get_guild(int(guild_id))
        if not guild:
            print(f"Guild ID {guild_id} not found.")
            return None
        for member in guild.members:
            if member.name.lower().strip() == user_name.lower().strip():
                return member.id
        return None

    def get_role_id(self, guild_id, role_name):
        """
        Get the role ID by name in a specific server/guild.
        """
        guild = self.get_guild(int(guild_id))
        if not guild:
            return None
        for role in guild.roles:
            if role.name.lower().strip() == role_name.lower().strip():
                return role.id
        return None

    async def add_category(self, guild_id, category_name):
        """
        Create a new category in the specified guild.
        """
        guild = self.get_guild(int(guild_id))
        if not guild:
            print(f"Guild ID {guild_id} not found.")
            return
        print(f"Creating category '{category_name}' in guild '{guild.name}'...")
        await guild.create_category(category_name)
        print(f"Category '{category_name}' created.")

    async def add_channel(self, guild_id, channel_name, category_id=None):
        """
        Create a new channel in the specified guild and optional category.
        """
        guild = self.get_guild(int(guild_id))
        if not guild:
            print(f"Guild ID {guild_id} not found.")
            return

        if category_id:
            # specific category specified
            category = guild.get_channel(int(category_id))
            if not category or not isinstance(category, discord.CategoryChannel):
                print(f"Category ID {category_id} not found.")
                return
            print(f"Creating channel '{channel_name}' in category '{category.name}'...")
            await category.create_text_channel(channel_name)
        else:
            # no category specified
            print(f"Creating channel '{channel_name}' in guild '{guild.name}'...")
            await guild.create_text_channel(channel_name)

        print(f"Channel '{channel_name}' created.")

    async def add_user_to_category(
        self, guild_id, user_id, category_id, permissions=None
    ):
        """
        Add a user to a category with the specified permissions.
        """
        guild = self.get_guild(int(guild_id))
        if not guild:
            print(f"Guild ID {guild_id} not found.")
            return

        category = guild.get_channel(int(category_id))
        if not category or not isinstance(category, discord.CategoryChannel):
            print(f"Category ID {category_id} not found.")
            return

        user = guild.get_member(int(user_id))
        if not user:
            print(f"User ID {user_id} not found.")
            return

        # create permission "overwrite"
        if not permissions:
            # default read-only permissions, if none specified
            permissions = discord.PermissionOverwrite(
                view_channel=True,
                read_messages=True,
                send_messages=False,
                manage_messages=False,
            )

        # add user to the category
        print(f"Adding user '{user.name}' to category '{category.name}'...")
        await category.set_permissions(user, overwrite=permissions)
        print(f"User '{user.name}' added to category '{category.name}'.")

    async def add_user_to_channel(
        self, guild_id, user_id, channel_id, permissions=None
    ):
        """
        Add a user to a channel with the specified permissions.
        """
        guild = self.get_guild(int(guild_id))
        if not guild:
            print(f"Guild ID {guild_id} not found.")
            return

        channel = guild.get_channel(int(channel_id))
        if not channel:
            print(f"Channel ID {channel_id} not found.")
            return

        user = guild.get_member(int(user_id))
        if not user:
            print(f"User ID {user_id} not found.")
            return

        # create permission "overwrite"
        if not permissions:
            # default read-only permissions, if none specified
            permissions = discord.PermissionOverwrite(
                view_channel=True,
                read_messages=True,
                send_messages=False,
                manage_messages=False,
            )

        # add user to the channel
        print(f"Adding user '{user.name}' to channel '{channel.name}'...")
        await channel.set_permissions(user, overwrite=permissions)
        print(f"User '{user.name}' added to channel '{channel.name}'.")

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

    def print_users(self, guild_id, category_id=None, channel_id=None):
        """
        Print a list of users in the specified guild, optionally filtered by category or channel.
        """
        guild = self.get_guild(int(guild_id))
        if not guild:
            print(f"Guild ID {guild_id} not found.")
            return

        subheading = f"{guild.name.upper()}"
        if category_id:
            category = guild.get_channel(int(category_id))
            if category and isinstance(category, discord.CategoryChannel):
                subheading += f" / '{category.name.upper()}'"
        if channel_id:
            channel = guild.get_channel(int(channel_id))
            if channel:
                subheading += f" / '{channel.name.upper()}'"

        print(f"{subheading:^100}")
        print(f"{'':-^100}")
        print(f"| {'User Name':<30} | {'ID':<30} | {'Roles':<30} |")
        print(f"| {'':-^30} | {'':-^30} | {'':-^30} |")

        if channel_id:
            # users in channel
            channel = guild.get_channel(int(channel_id))
            if channel:
                for member in channel.members:
                    # determine this user's roles
                    roles = ", ".join(
                        role.name for role in member.roles if role.name != "@everyone"
                    )
                    print(f"| {member.name:<30} | {member.id:<30} | {roles:<30} |")
                print(f"{'':-^100}")
                print()
                return
        if category_id:
            # users in category
            category = guild.get_channel(int(category_id))
            if category and isinstance(category, discord.CategoryChannel):
                user_ids = set()
                for member in guild.members:
                    # determine this user's roles
                    roles = ", ".join(
                        role.name for role in member.roles if role.name != "@everyone"
                    )
                    perms = category.permissions_for(member)
                    if perms.view_channel and member.id not in user_ids:
                        print(f"| {member.name:<30} | {member.id:<30} | {roles:<30} |")
                        user_ids.add(member.id)
                print(f"{'':-^100}")
                print()
                return
        else:
            # iterate through all members in the guild
            for member in guild.members:
                roles = ", ".join(
                    role.name for role in member.roles if role.name != "@everyone"
                )
                print(f"| {member.name:<30} | {member.id:<30} | {roles:<30} |")

        print(f"{'':-^100}")
        print()

    async def remove_category(self, guild_id, category_id, delete_channels=True):
        """
        Delete a category in the specified guild, optionally deleting its channels.
        """
        guild = self.get_guild(int(guild_id))
        if not guild:
            print(f"Guild ID {guild_id} not found.")
            return

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

    async def remove_channel(self, guild_id, channel_id):
        """
        Delete a channel in the specified guild and optional category.
        """
        guild = self.get_guild(int(guild_id))
        if not guild:
            print(f"Guild ID {guild_id} not found.")
            return

        channel = guild.get_channel(int(channel_id))
        if not channel:
            print(f"Channel ID {channel_id} not found.")
            return

        print(f"Deleting channel '{channel.name}'... from guild '{guild.name}'...")
        await channel.delete()
        print(f"Channel '{channel.name}' (ID: {channel.id}) deleted.")

    async def on_ready(self):
        """
        Event handler for when connection is cached and ready.
        Determine what to do.
        """

        # fix any server, category, or channel IDS that were specified as strings
        self.fix_ids()

        # print welcome message
        print(f"\nLogged in as user '{self.user.name}' (ID: {self.user.id})\n")

        # determine which actions to take
        if self.show_guilds:
            # print the available guilds (a.k.a. servers)
            self.print_guilds()
        if self.show_categories and self.guild_id:
            # print the available categories in the specified guild
            self.print_categories(self.guild_id)
        if self.show_channels and self.guild_id:
            # print the available channels in the specified guild
            self.print_channels(self.guild_id, self.category_id)
        if self.show_users and self.guild_id:
            # print the available users in the specified guild and optional category or channel
            self.print_users(self.guild_id, self.category_id, self.channel_id)
        if self.delete_category and self.guild_id:
            # delete the specified category in the specified guild, including all channels
            await self.remove_category(self.guild_id, self.delete_category)
        if self.delete_channel and self.guild_id:
            # delete the specified channel in the specified guild
            await self.remove_channel(self.guild_id, self.delete_channel)
        if self.create_category and self.guild_id:
            # create a new category in the specified guild
            await self.add_category(self.guild_id, self.create_category)
        if self.create_channel and self.guild_id:
            # create a new channel in the specified guild and optional category
            await self.add_channel(self.guild_id, self.create_channel, self.category_id)

        # close bot nicely
        await self.http.close()  # avoid warning about unclosed connections
        await self.close()


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
