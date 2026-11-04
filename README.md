# Boxy

## What is Boxy? (the assistant)

Boxy, the GitHub app, is an AI assistant based off our mascot, Boxy.


Boxy can respond to comments on issues and PRs, start background tasks to make plans and help on the codebase, and review PRs!
Boxy is meant to be for people who know what they are doing and are actual developers. It is NOT a slop-generating vibe coding clanker that will make everything for you. It is meant to review PRs made by humans, and help perform tasks to save time, not to replace a human's knowledge.

## Installing

The app isn't ready for public use yet, since it's mainly an in-house assistant, but you can install it by clicking on its profile any time you see it in a comment or commit around our repo.

## Self hosting

install pnpm if you haven't already (it's better than npm trust)
```sh
node runboxy.js 
```
this uses pnpm start under the hood and handles pulling updates and restarting, but it will not restart by itself if the computer restarts or you Ctrl+C the terminal 

use pm2 if you want to keep it on forever
we may provide an npm package in the future to make it easier and you better like it (whether you like it or not)

## Contributing

If you have suggestions for how boxy could be improved, or want to report a bug, open an issue! We'd love all and any contributions.

For more, check out the [Contributing Guide](CONTRIBUTING.md).

## License

[AGPL-3.0](LICENSE) © 2026 The OmniBlocks Team
OmniBlocks™ and Boxy™ are trademarks of the OmniBlocks Team. The art design for the Boxy mascot is ©2025-2026 The OmniBlocks Team, all rights reserved.
The rest of the code and assets are licensed under the AGPLv3 license unless otherwise noted.
