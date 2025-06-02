# Discord Channel Manager

A simple Discord channel manager that allows you to create, delete, and list channels in a Discord server using the Discord API.

## Requirements

`BOT_TOKEN` environment variable:

- a Discord bot token with `MANAGE_CHANNELS` permissions....
- can be loaded from a `.env` file.

## Usage

Three useful files... make them executable with `chmod u+x *.py *.ipynb`:

- `roster_setup.ipynb`: Jupyter notebook to merge a student roster CSV file with a questionnaire responses CSV file so that student `Email` addresses from the roster and `Discord` usernames from the questionnaire are kept in a single CSV result file. Open up in a Jupyter environment, configure the filenames, and run. The resulting combined CSV file will be saved into the `results` directory.

- `roster_create_channels.py`: creates private channels for each student in the combined roster/questionnaire result CSV file and sets appropriate permissions so the student and an administrator role can together see the channel. Configure the constants at the top of the file and then simply run, e.g. `./roster_create_channels.py`.

- `main.py`: can be used as a sort of command-line utility to list, create, and delete Discord servers, categories, channels, and roles. Run it to see options, e.g. `./main.py -h`.

- `response_bot.py`: a classic chatbot that handles incoming messages from Discord, fetches appropriate responses from OpenAI's Assistant API, then sends back the response to the user on Discord.... _still under development_ to make it more general-purpose and extensible. To start the bot, run `./response_bot.py`.

The main functionality of these scripts takes place in `discord_manager.py`, which contains the `DiscordManager` class that interacts with the Discord API. But you will likely not need to modify this file directly.
