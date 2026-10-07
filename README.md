# Bloombot

Bloombot helps university teaching teams run AI course assistants. Instructors use a web control panel to organize courses, connect Discord servers, add course guidance and materials, manage student access, and review conversations and usage. Students can ask course questions through Discord or the web chat.

## Current platform

The supported platform is the TypeScript application in `apps/`:

- `apps/web` is the instructor and student control panel.
- `apps/api` manages accounts, courses, and data for the panel.
- `apps/bot` answers questions in Discord.
- `apps/worker` handles background tasks such as roster imports and file processing.
- `apps/mcp` connects supported external AI assistants to Bloombot.
- `packages/` contains shared features used by these applications.

The Python bot and its companion setup tools in the repository root are deprecated. They are kept for existing installations and migration only; do not use them for a new setup. The platform can import data from the legacy system.

## Guides

- [Contribute to the codebase](CONTRIBUTING.md)
- [Run Bloombot on your computer](docs/RUNNING_LOCALLY.md)
- [Set up a Discord server](docs/DISCORD_SETUP.md)
- [Deploy Bloombot](docs/DEPLOY_DROPLET.md)
- [How the platform works](docs/ARCHITECTURE.md)

The remaining documents cover requirements, project planning, and specialist operations. The notebooks and Python files in the repository root belong to the deprecated system.

## Running on a server with pm2

See [Deploying to a Droplet](docs/DEPLOY_DROPLET.md) for production setup and process management.

## Continuous deployment

Changes merged to `master` deploy after CI succeeds. See [Deploying to a Droplet](docs/DEPLOY_DROPLET.md) for the workflow and its configuration.
