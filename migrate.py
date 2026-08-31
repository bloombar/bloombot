#!/usr/bin/env python3


"""
Set up database tables and populate with mock data, if desire.
Run from command line with optional --no-drop, --no-create, and --populate flags, all False by default.
Examples:
    python migrate.py --no-drop --no-create --populate
    python migrate.py --no-drop --populate
    python migrate.py
"""

import os
from pathlib import Path
import argparse
from peewee import SqliteDatabase
from models.user import User
from models.message import Message

# which tables we're interested in migrating
table_list = [User, Message]

# Define the database
db_path = Path(os.getenv("SQL_LITE_DB_PATH", "./data/data.db")).resolve()
db = SqliteDatabase(db_path)


def drop():
    # Connect to the database
    db.connect()
    # Drop all tables
    db.drop_tables(table_list, safe=True)
    # Close the connection
    db.close()
    print("- Database tables dropped.")


def create():
    # Connect to the database
    db.connect()

    # create the tables if they don't exist
    db.create_tables(table_list, safe=True)

    # Close the connection
    db.close()
    print("- Database tables created.")


def populate():
    # Connect to the database
    db.connect()

    # Create example User objects. These fields must match the User model — mock
    # data that drifts from the models makes --populate fail at insert time.
    users = [
        {
            "discord_id": 100000000000000001,
            "discord_username": "alice_smith",
            "email": "asmith@myuni.edu",
            "first_name": "Alice",
            "last_name": "Smith",
            "github_username": "alicesmith",
        },
        {
            "discord_id": 100000000000000002,
            "discord_username": "bob_johnson",
            "email": "bjohnson@myuni.edu",
            "first_name": "Bob",
            "last_name": "Johnson",
            "github_username": "bobjohnson",
        },
    ]

    # Insert users into the database in bulk
    User.insert_many(users).execute(db)

    # Iterate through all users and create a short mock exchange for each,
    # alternating direction the way a real conversation with the bot does.
    messages = []
    for user in User.select():

        # create mock messages
        new_messages = [
            {
                "user": user,
                "content": f"Hello from {user.first_name}!",
                "category": "Web Design - STUDENTS 01",
                "channel": user.email.split("@")[0],
                "direction": "from",
            },
            {
                "user": user,
                "content": f"Hello {user.first_name}, how can I help?",
                "category": "Web Design - STUDENTS 01",
                "channel": user.email.split("@")[0],
                "direction": "to",
            },
            {
                "user": user,
                "content": "When is the next assignment due?",
                "category": "Web Design - GLOBAL",
                "channel": "general",
                "direction": "from",
            },
        ]
        messages.extend(new_messages)  # add to greater list

    # done iterating through users... now add data to database

    # Insert messages into the database in bulk
    Message.insert_many(messages).execute(db)

    # No explicit commit: peewee runs in autocommit mode here, and calling
    # commit() with no transaction open raises OperationalError.

    # Close the connection
    db.close()
    print("- Database tables populated.")


# Create the table if it doesn't exist
if __name__ == "__main__":
    # Parse command-line arguments
    parser = argparse.ArgumentParser(description="Database migration script.")
    parser.add_argument(
        "--no-drop",
        action="store_true",
        help="Do not drop the tables, if existant.",
        default=False,
    )
    parser.add_argument(
        "--no-create",
        action="store_true",
        help="Do not create the tables.",
        default=False,
    )
    parser.add_argument(
        "--populate",
        action="store_true",
        help="Populate the tables with mock data.",
        default=False,
    )

    args = parser.parse_args()

    print(f"Migrating database: {db_path}...")

    # Check if the database file exists
    if not args.no_drop:
        drop()

    # Create the database and tables
    if not args.no_create:
        create()

    # Populate the database with example data
    if args.populate:
        populate()

    print("Done.")
