"""
Model for messages sent to and from users in Discord.
"""

# import datetime
# from pathlib import Path
from peewee import (
    CharField,
    ForeignKeyField,
)  # , Model, SqliteDatabase, AutoField, DateTimeField
from models.base import Base
from models.user import User


# Define the Message model
class Message(Base):
    """
    A Message sent to or from a user in Discord.
    This model stores the content of the message, the category and channel it was sent in,
    the direction of the message (to or from the user), and a reference to the user who sent or received.
    """

    content = CharField(null=False, unique=False)  # content of the message
    category = CharField(null=False, unique=False)  # Discord category name
    channel = CharField(null=False, unique=False)  # Discord channel name
    direction = CharField(
        choices=[("to", "To User"), ("from", "From User")],
        max_length=10,
        null=False,
        help_text="Indicates if the message was sent to or from the user",
    )  # whether the messsage was to or from this user to the bot
    user = ForeignKeyField(
        User, backref="messages", on_delete="CASCADE", null=False
    )  # the user who sent or received the message

    class Meta:
        # database = db  # Use the defined database
        table_name = "messages"

        indexes = (
            (("user",), False),
            (("created_at",), False),
        )
