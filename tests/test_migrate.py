"""
Tests for the database migration and its seed data (DATA-5, DATA-6).

conftest points SQL_LITE_DB_PATH at a throwaway file before any import, so
these tests build and tear down a real SQLite database without touching
data/data.db.
"""

import pytest

import migrate
from models.message import Message
from models.user import User


@pytest.fixture
def fresh_db():
    """A dropped-and-recreated database for each test."""
    migrate.drop()
    migrate.create()
    yield
    migrate.drop()


class TestCreateAndDrop:
    def test_create_makes_both_tables(self, fresh_db):
        assert User.table_exists()
        assert Message.table_exists()

    def test_drop_removes_both_tables(self, fresh_db):
        migrate.drop()
        assert not User.table_exists()
        assert not Message.table_exists()

    def test_create_is_safe_to_repeat(self, fresh_db):
        migrate.create()  # safe=True — must not raise on an existing schema
        assert User.table_exists()


class TestPopulate:
    """DATA-6 regression: the seed data set `phone`, `from_phone`, `to_phone`
    and `body`, none of which exist on the models, so --populate always raised.
    A stray db.commit() with no open transaction then raised on top of that."""

    def test_populate_succeeds(self, fresh_db):
        migrate.populate()  # must not raise
        assert User.select().count() == 2

    def test_seeds_messages_for_every_user(self, fresh_db):
        migrate.populate()
        assert Message.select().count() == 6
        for user in User.select():
            assert user.messages.count() == 3

    def test_seeded_users_carry_discord_fields(self, fresh_db):
        migrate.populate()
        user = User.get(User.first_name == "Alice")
        assert user.discord_username == "alice_smith"
        assert user.discord_id
        assert "@" in user.email
        assert user.github_username

    def test_seeded_messages_use_both_directions(self, fresh_db):
        migrate.populate()
        directions = {m.direction for m in Message.select()}
        assert directions == {"to", "from"}

    def test_seeded_messages_carry_category_and_channel(self, fresh_db):
        migrate.populate()
        for message in Message.select():
            assert message.category
            assert message.channel
            assert message.content

    def test_seeded_messages_link_back_to_a_user(self, fresh_db):
        migrate.populate()
        user_ids = {u.id for u in User.select()}
        for message in Message.select():
            assert message.user.id in user_ids
