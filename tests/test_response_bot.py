"""
Tests for the chatbot's pure decision logic: course routing (BOT-2, BOT-3,
BOT-12) and daily rate-limit accounting (BOT-5, BOT-11).

These functions were extracted from `on_message` precisely so they can be
exercised without a Discord connection or an OpenAI call.
"""

import response_bot as bot


# ---------------------------------------------------------------- categories

class TestGetCategoryNames:
    """A course's categories may be plain strings or dicts with a channel list."""

    def test_reads_both_config_formats(self, courses):
        assert bot.get_category_names(courses[0]) == [
            "Web Design - GLOBAL",
            "Web Design - STUDENTS 01",
        ]

    def test_plain_string_categories(self, courses):
        assert bot.get_category_names(courses[1]) == [
            "Python - GLOBAL",
            "Python - STUDENTS 01",
        ]

    def test_course_with_no_categories(self):
        assert bot.get_category_names({"title": "Empty"}) == []


# ------------------------------------------------------- BOT-2 routing by category

class TestFindCourseByCategory:
    def test_matches_dict_format_category(self, courses):
        assert bot.find_course_by_category(
            courses, "Web Design - GLOBAL"
        )["title"] == "Web Design"

    def test_matches_plain_string_category(self, courses):
        assert bot.find_course_by_category(
            courses, "Python - STUDENTS 01"
        )["title"] == "Introduction to Programming"

    def test_routes_each_course_to_its_own_config(self, courses):
        """The point of routing: a Web Design question must not reach Python's
        vector store, and vice versa."""
        wd = bot.find_course_by_category(courses, "Web Design - STUDENTS 01")
        py = bot.find_course_by_category(courses, "Python - GLOBAL")
        assert wd["openai_assistant"]["vector_store_id"] == "vs_web_design"
        assert py["openai_assistant"]["vector_store_id"] == "vs_python"

    def test_unknown_category_matches_nothing(self, courses):
        assert bot.find_course_by_category(courses, "Some Other Category") is None

    def test_missing_category_matches_nothing(self, courses):
        # An uncategorized channel or a DM has no category at all.
        assert bot.find_course_by_category(courses, None) is None

    def test_empty_course_list(self):
        assert bot.find_course_by_category([], "Web Design - GLOBAL") is None


# --------------------------------------------- BOT-3 / BOT-12 routing by role

class TestFindCourseByRoles:
    def test_matches_student_role(self, courses):
        """BOT-12 regression: the fallback previously read a `student` key that
        no configuration defines, so students were never matched by role."""
        assert bot.find_course_by_roles(
            courses, ["students-wd-su26"]
        )["title"] == "Web Design"

    def test_matches_admin_role(self, courses):
        assert bot.find_course_by_roles(
            courses, ["admins-py-su26"]
        )["title"] == "Introduction to Programming"

    def test_matches_alongside_unrelated_roles(self, courses):
        assert bot.find_course_by_roles(
            courses, ["@everyone", "nyu", "students-py-su26"]
        )["title"] == "Introduction to Programming"

    def test_unknown_role_matches_nothing(self, courses):
        assert bot.find_course_by_roles(courses, ["some-other-role"]) is None

    def test_no_roles_matches_nothing(self, courses):
        assert bot.find_course_by_roles(courses, []) is None
        assert bot.find_course_by_roles(courses, None) is None

    def test_course_without_roles_block(self):
        assert bot.find_course_by_roles([{"title": "Bare"}], ["anything"]) is None


# ------------------------------------------------- BOT-5 / BOT-11 rate limiting

class TestRequestsUsedToday:
    def test_unknown_user_has_used_nothing(self):
        assert bot.requests_used_today(None, "2026-08-31") == 0

    def test_counts_requests_made_today(self):
        stats = {"num_requests": 7, "last_response_date": "2026-08-31"}
        assert bot.requests_used_today(stats, "2026-08-31") == 7

    def test_yesterdays_count_expires(self):
        """BOT-11 regression: a stale count must read as zero. Previously the
        reset only happened while recording a response, which an over-limit user
        could never reach — locking them out permanently rather than for a day."""
        stats = {"num_requests": 25, "last_response_date": "2026-08-30"}
        assert bot.requests_used_today(stats, "2026-08-31") == 0

    def test_over_limit_user_is_released_the_next_day(self):
        """The end-to-end property BOT-11 specifies, at the limit check."""
        limit = 20
        stats = {"num_requests": limit + 1, "last_response_date": "2026-08-30"}
        assert bot.requests_used_today(stats, "2026-08-30") > limit   # blocked
        assert bot.requests_used_today(stats, "2026-08-31") == 0      # released

    def test_missing_date_reads_as_zero(self):
        assert bot.requests_used_today({"num_requests": 3}, "2026-08-31") == 0

    def test_missing_count_reads_as_zero(self):
        assert bot.requests_used_today(
            {"last_response_date": "2026-08-31"}, "2026-08-31"
        ) == 0
