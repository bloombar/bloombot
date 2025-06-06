"""
Base model inherited by others.
"""

import os
import datetime
from pathlib import Path
from dotenv import load_dotenv
from peewee import (
    Model,
    SqliteDatabase,
    # AutoField,
    # ForeignKeyField,
    # CharField,
    DateTimeField,
    DoesNotExist,
)

load_dotenv()  # load environment variables from .env file

# Define the database
db_path = Path(os.getenv("SQL_LITE_DB_PATH", "./data/data.db")).resolve()
db = SqliteDatabase(db_path)
db.execute_sql("SELECT 1;")
print("- Database connection established.")


# Define the Base model all other models are based on
class Base(Model):
    """
    Base class for all models, providing basic db connection info, and a few useful methods.
    """

    # id = AutoField() # auto-created
    created_at = DateTimeField(default=datetime.datetime.now)
    updated_at = DateTimeField(default=datetime.datetime.now)

    class Meta:
        database = db  # Use the defined database

    @classmethod
    def get_or_create(cls, **kwargs):
        """
        Overrides default get_or_create to allow multiple fields to be used for lookup.

        Args:
            **kwargs: Keyword arguments representing the fields to search for.
                Example (e.g. User sub-class): discord_id=123456789, email="user@example.com"

        Returns:
            tuple: (Matching instance, created boolean)
                - Matching instance: The matching object if found or created.
                - created boolean: True if a new instance was created, False if an existing instance was found.
        """
        query = None
        for key, value in kwargs.items():
            # ignore key names that do not exist as fields in the class
            if hasattr(cls, key) and value is not None:
                condition = getattr(cls, key) == value
                query = condition if query is None else (query | condition)
        if query is not None:
            try:
                user = cls.get(query)
                return user, False
            except DoesNotExist:
                user = cls.create(**kwargs)
                return user, True
        else:
            user = cls.create(**kwargs)
            return user, True

    def merge(self, data, ignore_fields=None):
        """
        Merge this data record with another of the same type.
        """
        changed = False
        for key, value in data.items():
            if ignore_fields and key in ignore_fields:
                continue
            else:
                if (
                    value
                    and hasattr(self, key)
                    and getattr(self, key) in [None, "null", "", [], {}]
                ):
                    print(f"\n{type(self).__name__} update: '{key}' -> '{value}'")
                    setattr(self, key, value)
                    changed = True
                elif value and hasattr(self, key) and getattr(self, key) != value:
                    print(f"\n{type(self).__name__} update: '{key}' -> '{value}'")
                    setattr(self, key, value)
                    changed = True
        if changed:
            self.save()


# Create the table if it doesn't exist
if __name__ == "__main__":
    db.connect()
    # db.create_tables([Base])
    db.close()
