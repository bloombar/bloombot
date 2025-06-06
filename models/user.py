# import datetime
# from pathlib import Path
import os
import csv
from pathlib import Path
from peewee import (
    CharField,
    IntegerField,
)  # ForeignKeyField, Model, SqliteDatabase, AutoField, DateTimeField
from models.base import Base


# Define the User model
class User(Base):
    """
    A User with personal details, Discord account and email account information.
    Typical lookups will be by Discord id, username, or email address.
    """

    # id, created_at, updated_at are inherited from Base
    discord_id = IntegerField(null=True, unique=True)
    discord_username = CharField(null=True, unique=False)
    email = CharField(null=True, unique=False)
    last_name = CharField(null=True, unique=False)
    first_name = CharField(null=True, unique=False)
    github_username = CharField(null=True, unique=False)

    class Meta:
        table_name = "users"
        indexes = (
            (("email",), True),
            (("discord_id",), True),
        )

    # @classmethod
    # def get_or_create(cls, **query):
    #     """
    #     Override Base model's get_or_create.
    #     Try to find a user's personal details and email address from CSV roster file, if present.
    #     """
    #     obj, created = super().get_or_create(**query)

    #     # TBD: do additional work here... look for user in CSV file

    #     return obj, created
