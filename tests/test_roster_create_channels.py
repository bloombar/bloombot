"""
Tests for per-student channel creation: the roster path (ROST-7) and the pinned
welcome message (ROST-8).

Importing this module runs its configuration block, which reads bot_config.yml
and constructs a DiscordManager. That construction opens no connection, so the
import is safe in a test run with no credentials.
"""

import types

import roster_create_channels as rcc


class TestRosterPath:
    def test_roster_is_read_from_the_results_directory(self):
        """ROST-7 regression: the path was built without the `results/` prefix,
        so it resolved against the repo root and the roster was never found."""
        assert rcc.ROSTER_FILE.parent.name == "results"

    def test_roster_filename_uses_the_course_file_prefix(self):
        # The configured course is 'Introduction to Programming', prefix 'py'.
        assert rcc.ROSTER_FILE.name == "py-result.csv"

    def test_roster_path_is_absolute(self):
        assert rcc.ROSTER_FILE.is_absolute()


ROW = {
    "First": "Alice",
    "Last": "Smith",
    "Discord": "alice_smith",
    "GitHub": "alicesmith",
}
ADMINS_ROLE_ID = 555000111


class TestFormatWelcomeMessage:
    def message_for(self, member):
        return rcc.format_welcome_message(
            ROW, "asmith@myuni.edu", ADMINS_ROLE_ID, member
        )

    def test_mentions_the_student_by_numeric_id(self):
        """ROST-8 regression: the member's *username* was interpolated into
        Discord's *role*-mention syntax, so the student was never pinged."""
        member = types.SimpleNamespace(id=987654321, name="alice_smith")
        assert self.message_for(member).startswith("\n<@987654321>,")

    def test_does_not_use_role_syntax_for_the_student(self):
        member = types.SimpleNamespace(id=987654321, name="alice_smith")
        assert "<@&987654321>" not in self.message_for(member)

    def test_does_not_mention_the_student_by_username(self):
        member = types.SimpleNamespace(id=987654321, name="alice_smith")
        assert "<@alice_smith>" not in self.message_for(member)

    def test_mentions_the_admins_role(self):
        member = types.SimpleNamespace(id=987654321, name="alice_smith")
        assert f"<@&{ADMINS_ROLE_ID}>" in self.message_for(member)

    def test_unresolved_member_gets_the_correction_notice(self):
        message = self.message_for(None)
        assert "Alice Smith" in message
        assert "incorrect" in message
        assert "<@" not in message.split("Student details")[0].replace(
            f"<@&{ADMINS_ROLE_ID}>", ""
        )

    def test_includes_the_student_details_block(self):
        message = self.message_for(None)
        for expected in (
            "**First:** Alice",
            "**Last Name:** Smith",
            "**Email:** asmith@myuni.edu",
            "**Discord:** alice_smith",
            "**GitHub:** alicesmith",
        ):
            assert expected in message

    def test_missing_csv_columns_render_empty(self):
        message = rcc.format_welcome_message({}, "x@y.edu", ADMINS_ROLE_ID, None)
        assert "**First:** \n" in message
        assert "**Email:** x@y.edu" in message
