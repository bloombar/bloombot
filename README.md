# Bloombot - AI Course Assistant

An AI Course Assistant and Discord server utility with two parts:

1. An AI Course Assistant bot setup as a Discord App that responds to messages by proxying them to the OpenAI API with a bit of extra prompt engineering to tailor the responses. Intended for use by students in a course.

2. A set of Discord server management utilities that allow you to automatically create, delete, and list channels in a Discord server using the Discord API. Intended for use by instructors of one or more courses.

## Requirements

`BOT_TOKEN` environment variable:

- a Discord bot token with `MANAGE_CHANNELS` permissions....
- can be loaded from a `.env` file. See [.env file example](./env.example)

## Usage

Five useful files... make them executable with `chmod u+x *.py *.ipynb`:

- `roster_setup.ipynb`: Jupyter notebook to merge a student roster CSV file with a questionnaire responses CSV file so that student `Email` addresses from the roster and `Discord` usernames from the questionnaire are kept in a single CSV result file. Open up in a Jupyter environment, configure the filenames, and run. The resulting combined CSV file will be saved into the `results` directory. See sample source files in the `rosters` and `questionnaires` directories and sample output file in the `results` directory.

- `hydrate_server.py`: creates the category structure in the Discord server for all courses defined in `bot_config.yml`. Sets role-based permissions on each category (admins and students roles). Intended to be run once to scaffold the server before running `roster_create_channels.py`. Run with `./hydrate_server.py`.

- `roster_create_channels.py`: creates private channels in the Discord server for each student in the combined roster/questionnaire result CSV file and sets appropriate permissions so the student and administrator roles can together see the channel. Configure the constants at the top of the file and then simply run, e.g. `./roster_create_channels.py`. Run after `hydrate_server.py` has created the category structure.

- `main.py`: can be used as a sort of command-line utility to list, create, and delete Discord servers, categories, channels, and roles. Run it to see options, e.g. `./main.py -h`.

- `response_bot.py`: a chatbot that handles incoming messages from Discord, fetches appropriate responses from OpenAI's API, then sends back the response to the user on Discord. To start the bot, run `./response_bot.py`. Configuration options specific this use of the bot intelligently across several different categories of channels in a Discord server used for teaching courses at a university are available in the `bot_config.yml` file. Different courses can be set to use different OpenAI Assistants, each with their own course notes files uploaded through OpenAI's Assistants settings dashboard.

---

The main functionality of these scripts takes place in `discord_manager.py`, which contains the `DiscordManager` class that interacts with the Discord API. But you will likely not need to modify this file directly.

## Running on a Server with pm2

[pm2](https://pm2.keymetrics.io/) is a process manager that keeps `response_bot.py` running in the background, restarts it on crash, and survives server reboots.

### Prerequisites

```bash
npm install -g pm2
```

### Starting the bot

**Without the ecosystem config** (quick, one-off):

```bash
pm2 start response_bot.py --interpreter python3 --name bloombot
```

**With the ecosystem config** (recommended — reproducible across deploys):

```bash
pm2 start ecosystem.config.js
```

Environment variables are loaded from `.env` automatically by the bot, so no additional configuration is needed in either case.

### Persisting across reboots

Run these once after first starting the bot:

```bash
pm2 save          # saves the current process list
pm2 startup       # prints a command to run — copy and run it to enable autostart
```

### Common commands

```bash
pm2 status                  # show running processes
pm2 logs bloombot           # stream live logs
pm2 restart bloombot        # restart the bot
pm2 stop bloombot           # stop the bot
pm2 delete bloombot         # remove from pm2's process list
```
