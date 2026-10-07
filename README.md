# Bloombot

Bloombot gives a university course its own AI teaching assistant. Students ask it questions about the course, and it answers using the guidance and materials the teaching team provides.

## For teaching teams

Instructors and course staff work in a web control panel, where they can:

- set up courses and group them into projects, such as one per semester
- write the assistant's instructions for each course and attach course materials
- connect a Discord server, so the assistant can answer in the course's channels
- decide which students have access
- read past conversations and see how much the assistant is being used

## For students

Students ask questions in their course's Discord server or in the web chat. They can also connect their Bloombot account to ChatGPT or Claude and ask from there.

## Getting started

Bloombot is run by an operator, usually someone in your department or institution. Ask them for the web address and sign in with your email address. Then follow [Setting up Bloombot in a Discord server](docs/DISCORD_SETUP.md) from step 3 onward to connect your course's server.

## Student data

Bloombot stores only what students and instructors provide and agree to. The privacy policy and terms of use are linked at the bottom of every page.

## More information

- [Contributing](CONTRIBUTING.md) — for developers working on Bloombot
- [Deploying Bloombot](docs/DEPLOY_DROPLET.md) — for operators running their own copy
- [Moving from the old Python bot](docs/CUTOVER.md) — for existing installations only

The Python files and notebooks in the top folder belong to an earlier version of Bloombot. That version is no longer supported and is kept only so existing installations can move their data over.
