"""
Tests for DiscordManager's name-or-id lookup helpers (DSC-2, DSC-7).

The lookups only read `self.guilds` and the objects hanging off it, so they are
exercised against lightweight fakes rather than a live Discord connection. The
real client is never constructed — its __init__ builds gateway intents and is
irrelevant to the resolution logic under test.
"""

import types

from discord_manager import DiscordManager


def make_guild(guild_id, name, categories=(), roles=()):
    """Build a stand-in for a discord.Guild carrying only what lookups read."""
    return types.SimpleNamespace(
        id=guild_id,
        name=name,
        categories=[
            types.SimpleNamespace(id=cid, name=cname) for cid, cname in categories
        ],
        roles=[types.SimpleNamespace(id=rid, name=rname) for rid, rname in roles],
    )


def make_client(guilds):
    """A DiscordManager with `guilds` stubbed, bypassing __init__ entirely."""
    client = DiscordManager.__new__(DiscordManager)
    client.__dict__["_test_guilds"] = guilds
    type(client).guilds = property(lambda self: self.__dict__["_test_guilds"])
    return client


GUILDS = [
    make_guild(111, "Other Server"),
    make_guild(222, "Knowledge Kitchen", categories=[(10, "Web Design - GLOBAL")]),
]


class TestGetServerId:
    def test_finds_server_by_name(self):
        assert make_client(GUILDS).get_server_id("Knowledge Kitchen") == 222

    def test_name_match_is_case_and_space_insensitive(self):
        assert make_client(GUILDS).get_server_id("  knowledge kitchen ") == 222

    def test_finds_server_by_integer_id(self):
        """DSC-7 regression: operator precedence made the integer branch return
        the FIRST guild without ever comparing ids."""
        assert make_client(GUILDS).get_server_id(222) == 222

    def test_integer_id_does_not_return_the_wrong_server(self):
        # The sharpest form of the DSC-7 defect: asking for the second server
        # used to hand back the first one.
        assert make_client(GUILDS).get_server_id(222) != 111

    def test_finds_server_by_numeric_string_id(self):
        assert make_client(GUILDS).get_server_id("222") == 222

    def test_unknown_integer_id_returns_none(self):
        assert make_client(GUILDS).get_server_id(999) is None

    def test_unknown_name_returns_none(self):
        assert make_client(GUILDS).get_server_id("Nonexistent Server") is None

    def test_no_guilds_returns_none(self):
        assert make_client([]).get_server_id("Knowledge Kitchen") is None


class TestGetCategoryId:
    """The category lookup already grouped its condition correctly; these tests
    pin that behavior so the two lookups cannot drift apart again."""

    def make(self):
        client = make_client(GUILDS)
        client.get_guild = lambda gid: next(
            (g for g in GUILDS if g.id == int(gid)), None
        )
        return client

    def test_finds_category_by_name(self):
        assert self.make().get_category_id(222, "Web Design - GLOBAL") == 10

    def test_finds_category_by_integer_id(self):
        assert self.make().get_category_id(222, 10) == 10

    def test_unknown_integer_id_returns_none(self):
        assert self.make().get_category_id(222, 99) is None

    def test_unknown_name_returns_none(self):
        assert self.make().get_category_id(222, "No Such Category") is None

    def test_unknown_guild_returns_none(self):
        assert self.make().get_category_id(333, "Web Design - GLOBAL") is None
