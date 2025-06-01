import os
import discord
from discord import app_commands
from dotenv import load_dotenv

load_dotenv()  # load environment variables from .env file


class DiscordManager(discord.Client):
    """
    A Discord client for managing servers (a.k.a. guilds), categories, and channels.
    Add, remove, delete, and list Discord servers, categories, and channels.
    Requires a Discord bot token as an environment variable, .env file, or command line argument.
    """

    @staticmethod
    def create_permissions(
        view_channel=True,
        read_messages=True,
        send_messages=False,
        manage_messages=False,
    ):
        """
        Create permission overwrite for channels or categories.
        """
        return discord.PermissionOverwrite(
            view_channel=view_channel,
            read_messages=read_messages,
            send_messages=send_messages,
            manage_messages=manage_messages,
        )

    def __init__(
        self,
        token=os.getenv("BOT_TOKEN"),
        event_loop=True,  # by default start listening for events
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
        Instantiate the Discord client with the dinges.

        Args:
            token (str): The bot token to use for authentication. Defaults to the environment variable BOT_TOKEN.
            event_loop (bool): Whether to use an event loop. If False, the bot will close the connection nicely after initial actions.
            show_guilds (bool): Whether to show the available guilds (servers).
            show_categories (bool): Whether to show the available categories in the specified guild.
            show_channels (bool): Whether to show the available channels in the specified guild and optional category.
            show_users (bool): Whether to show the available users in the specified guild and optional category or channel.
            guild_id (int or str): The ID or name of the guild to operate on.
            category_id (int or str): The ID or name of the category to operate on. If None, no specific category is targeted.
            channel_id (int or str): The ID or name of the channel to operate on. If None, no specific channel is targeted.
            user_id (int or str): The ID or name of the user to operate on. If None, no specific user is targeted.
            role_id (int or str): The ID or name of the role to operate on. If None, no specific role is targeted.
            delete_category (int or str): The ID or name of the category to delete. If None, no category is deleted.
            delete_channel (int or str): The ID or name of the channel to delete. If None, no channel is deleted.
            create_category (str): The name of the category to create. If None, no category is created.
            create_channel (str): The name of the channel to create. If None, no channel is created.


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
        self.event_loop = event_loop  # whether to start listening for events
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
        Get the server ID by name or ID.

        Args:
            server_name (str or int): The name or ID of the server to find.
        Returns:
            int or None: The ID of the server if found, None otherwise.
        """
        for guild in self.guilds:
            # check if server_name is an integer ID or a string name
            if (
                isinstance(server_name, int)
                or (isinstance(server_name, str) and server_name.isnumeric())
                and guild.id == int(server_name)
            ):
                # the category ids match
                return guild.id
            elif (
                isinstance(server_name, str)
                and guild.name.lower().strip() == server_name.lower().strip()
            ):
                # the category names match
                return guild.id
        return None

    def get_category_id(self, guild_id, category_name):
        """
        Get the category ID by name or ID.

        Args:
            guild_id (int): The ID of the guild to search in.
            category_name (str or int): The name or ID of the category to find.
        Returns:
            int or None: The ID of the category if found, None otherwise.
        """
        guild = self.get_guild(int(guild_id))
        if not guild:
            return None
        for category in guild.categories:
            # check if category_name is an integer ID or a string name
            if (
                isinstance(category_name, int)
                or (isinstance(category_name, str) and category_name.isnumeric())
            ) and category.id == int(category_name):
                # the category ids match
                return category.id
            elif (
                isinstance(category_name, str)
                and category.name.lower().strip() == category_name.lower().strip()
            ):
                # the category names match
                return category.id
        return None

    def get_channel_id(
        self,
        guild_id,
        channel_name,
        category_id=None,
    ):
        """
        Get the channel ID by name or ID.

        Args:
            guild_id (int): The ID of the guild to search in.
            channel_name (str or int): The name or ID of the channel to find.
            category_id (int or None): The ID of the category to search in, if any.
        Returns:
            int or None: The ID of the channel if found, None otherwise.
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
                # check if channel_name is an integer ID or a string name
                if (
                    isinstance(channel_name, int)
                    or (isinstance(channel_name, str) and channel_name.isnumeric())
                ) and channel.id == int(channel_name):
                    # the channel ids match
                    return channel.id
                elif (
                    isinstance(channel_name, str)
                    and channel.name.lower().strip() == channel_name.lower().strip()
                ):
                    # the channel names match
                    return channel.id
        else:
            # no category specified
            for channel in guild.channels:
                # check if channel_name is an integer ID or a string name
                if (
                    isinstance(channel_name, int)
                    or (isinstance(channel_name, str) and channel_name.isnumeric())
                    and channel.id == int(channel_name)
                ):
                    # the channel ids match
                    return channel.id
                elif (
                    isinstance(channel_name, str)
                    and channel.name.lower().strip() == channel_name.lower().strip()
                ):
                    # the channel names match
                    return channel.id
        return None

    def get_user_id(self, guild_id, user_name, match_display_names=True):
        """
        Get the user ID by name or ID.

        Args:
            guild_id (int): The ID of the guild to search in.
            user_name (str or int): The name or ID of the user to find.
            match_display_names (bool): Whether to match display names as well.
        Returns:
            int or None: The ID of the user if found, None otherwise.
        """
        guild = self.get_guild(int(guild_id))
        if not guild:
            print(f"Guild ID {guild_id} not found.")
            return None

        # clean up user name to remove any text after a '#' or '(', if any
        # usernames are self-reported by students, they mess them up constantly
        if isinstance(user_name, str):
            user_name = user_name.split("#")[0]
        user_name = user_name.strip()  # remove unnecessary whitespace

        for member in guild.members:
            # check if user_name is an integer ID or a string name
            if (
                isinstance(user_name, int)
                or (isinstance(user_name, str) and user_name.isnumeric())
                and member.id == int(user_name)
            ):
                # the user ids match
                return member.id
            elif (
                isinstance(user_name, str)
                and member.name.lower().strip() == user_name.lower().strip()
            ):
                # the user names match
                return member.id
            elif (
                match_display_names
                and isinstance(user_name, str)
                and member.display_name.lower().strip() == user_name.lower().strip()
            ):
                # the display names match
                return member.id
        return None

    def get_role_id(self, guild_id, role_name):
        """
        Get the role ID by name or ID.

        Args:
            guild_id (int): The ID of the guild to search in.
            role_name (str or int): The name or ID of the role to find.
        Returns:
            int or None: The ID of the role if found, None otherwise.
        """
        guild = self.get_guild(int(guild_id))
        if not guild:
            return None

        for role in guild.roles:
            # check if role_name is an integer ID or a string name
            if (
                isinstance(role_name, int)
                or (isinstance(role_name, str) and role_name.isnumeric())
                and role.id == int(role_name)
            ):
                # the role ids match
                return role.id
            elif (
                isinstance(role_name, str)
                and role.name.lower().strip() == role_name.lower().strip()
            ):
                # the role names match
                return role.id
        return None

    async def add_category(self, guild_id, category_name, duplicates=False):
        """
        Create a new category in the specified guild.
        """
        guild = self.get_guild(int(guild_id))
        if not guild:
            print(f"Guild ID {guild_id} not found.")
            return

        # prevent duplicates, if desired.
        if not duplicates and self.get_category_id(guild_id, category_name):
            # category exists... do not create duplicate
            print(f"Category '{category_name}' already exists in '{guild.name}'.")
            return

        # create category
        print(f"Creating category '{category_name}' in guild '{guild.name}'...")
        await guild.create_category(category_name)
        print(f"Category '{category_name}' created.")

    async def add_channel(
        self, guild_id, channel_name, category_id=None, duplicates=False
    ):
        """
        Create a new channel in the specified guild and optional category.
        """
        guild = self.get_guild(int(guild_id))
        if not guild:
            print(f"Guild ID {guild_id} not found.")
            return

        # prevent duplicates, if desired.
        if not duplicates and self.get_channel_id(guild_id, channel_name, category_id):
            # channel exists... do not create duplicate
            print(f"Channel '{channel_name}' already exists in '{guild.name}'.")
            return

        # create channel
        if category_id:
            category_id = self.get_category_id(guild_id, category_id)  # ensure int
            # specific category specified
            category = guild.get_channel(category_id)
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

        category_id = self.get_category_id(guild_id, category_id)  # ensure int
        category = guild.get_channel(category_id)
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
            permissions = self.create_permissions()  # default permissions

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
            permissions = self.create_permissions()  # default permissions

        # add user to the channel
        print(f"Adding user '{user.name}' to channel '{channel.name}'...")
        await channel.set_permissions(user, overwrite=permissions)
        print(f"User '{user.name}' added to channel '{channel.name}'.")

    async def add_user_to_role(self, guild_id, user_id, role_id):
        """
        Add a user to a role in the specified guild.
        """
        guild = self.get_guild(int(guild_id))
        if not guild:
            print(f"Guild ID {guild_id} not found.")
            return

        # clean up user_id and role_id in case names are given instead of IDs.
        user_id = self.get_user_id(guild_id, user_id)  # if string name given...
        role_id = self.get_role_id(guild_id, role_id)  # if string name given...

        # get the user
        user = guild.get_member(int(user_id))
        if not user:
            print(f"User ID {user_id} not found.")
            return

        role = guild.get_role(int(role_id))
        if not role:
            print(f"Role ID {role_id} not found.")
            return

        # add user to the role
        print(f"Adding user '{user.name}' to role '{role.name}'...")
        await user.add_roles(role)
        print(f"User '{user.name}' added to role '{role.name}'.")

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
            category_id = self.get_category_id(guild_id, category_id)  # ensure int
            # specific category specified
            category = guild.get_channel(category_id)  # get category details, if any

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
            category_id = self.get_category_id(guild_id, category_id)  # ensure int
            category = guild.get_channel(category_id)
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
            category = guild.get_channel(category_id)
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

        category_id = self.get_category_id(guild_id, category_id)  # ensure int
        category = guild.get_channel(category_id)
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

    async def start(self, token=None):
        """
        Open the connection to Discord and start the bot.

        Args:
            token (str): The bot token to use for authentication. Defaults to the environment variable BOT_TOKEN.
        """
        await super().start(token or self.token)

    async def stop(self):
        """
        Close the bot connection nicely.
        """
        await self.http.close()  # avoid warning about unclosed connections
        await self.close()

    async def on_ready(self):
        """
        Event handler for when connection is cached and ready.
        Determine what to do as initial action and whether to keep listening for more or stop.
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

        if not self.event_loop:
            # if not listening for events, stop the bot after initial actions
            # print("Stopping bot after initial actions...")
            await self.stop()
