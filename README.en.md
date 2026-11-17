[简体中文](README.md) · [English](README.en.md)

# Yexi · Texas Hold’em around one table

Play face-to-face Texas Hold’em while phones track virtual chips. One computer runs a local server, and phones on the same Wi-Fi scan a QR code to join. Choose **physical cards** (deal your own cards while the app tracks chips) or **digital cards** (the app shuffles and deals, keeps hole cards on each player’s phone, and awards pots by hand strength at showdown). **Entertainment points only: no deposits, withdrawals, or conversion to real money.** Yexi does not calculate equity, odds, or GTO strategies.

> **Disclaimer:** Yexi records **virtual entertainment points** for friends playing, learning, and reviewing hands together in person. It has no deposit, withdrawal, transfer, cash conversion, or payment-settlement features, and never will. Do not use it for gambling, and follow the laws where you live.

The interface supports 简体中文, 繁體中文, English, 日本語, 한국어, and Español. Switch languages in the page header. Your choice is saved in your browser and does not change anyone else’s interface. Until you choose a language, Yexi follows your browser’s language, falling back to English for unsupported languages.

## Install and start

Requires **Node.js 22.13 or later** for the built-in `node:sqlite` module. All unit tests have run on 22.13.0 and 24.22; Node.js 24 LTS is recommended. No database service, account, cloud service, or build step is needed.

```bash
git clone https://github.com/jinxlzc/yexi-poker.git
cd yexi-poker
npm ci --omit=dev   # Runtime dependencies only (ws and qrcode); omit --omit=dev to run tests
npm start
```

Node 22 prints an `ExperimentalWarning` for `node:sqlite`; you can ignore it.

Once dependencies are installed, just run `npm start`. No build step, cloud service, account, or external database is required. Fonts, pages, QR codes, and sounds are served locally, with no CDN dependency.

1. Open **http://localhost:8787** on the computer and create a room. Choose how to deal: digital cards are selected initially, and you can switch to physical cards. Defaults are a small blind of 10, big blind of 20, starting stack of 2,000, and rebuys off.
2. The terminal and start page show the computer’s local network addresses in the form `http://<LAN-address>:8787`. Use the actual address shown on your computer.
3. Connect phones to the same Wi-Fi as the computer. Scan the QR code on the share page, or open the local network address and enter the four-character room code. Pick a name and an empty seat.
4. Once at least two players are seated, select “New hand” on the computer. If the host is also playing, they should take a seat on a phone too. By default, the host credential stays in the computer browser that created the room.
5. Players act on their own phones. With physical cards, betting stops at the end of each round until the host selects “Next street.” After dealing the physical cards, the host selects the winner of each pot, reviews the preview, and confirms the awards. With digital cards, “Next street” deals the community cards, and the app evaluates the showdown. Both modes support voting on multiple runouts once betting is locked in an all-in hand; see “Table rules.”
6. To correct a mistake, select “Undo” on the computer and confirm. Settlement, starting a hand, and blinds can also be undone. Animations do not play backward; the numbers immediately return to the restored state.
7. Between hands, use “Seats” to change the dealing mode, move players, adjust blind levels, or configure antes, the action timer, the maximum number of all-in runouts, and straddles.
8. At the end of the evening, the host selects “End session” in the dock between hands and confirms. The room becomes read-only. Each phone opens its player’s session recap, while the computer shows the table standings, duration, hand count, chip-balance check, and highlights. Copy a text recap or save an image; revisit it through “Past sessions” on the home page. Start another room with the same settings, and phones offer a link to join the new table. Ending a session can be undone.

## Over the course of an evening (version 4)

- **Leaving early:** Players use “More → Leave,” or the host removes their seat. Buy-ins, chips taken away, and hands played remain in the ledger. Their phone immediately shows their own session recap, and they remain in the final standings. Returning on the same phone continues their existing statistics.
- **Sitting out:** Use “Sit out” at the bottom of the phone screen, or have the host change it on the seats page. Starting with the next hand, that player receives no cards and posts no blinds. No missed blinds are owed. Select “I’m back” to rejoin on the next hand.
- **Joining late:** Scan the code and take a seat at any time; play begins on the next hand.
- **Rebuys:** The host can add chips on the seats page. Players can also use “More → Request rebuy”; the host approves it at the table and can adjust the amount.
- **New phone or cleared browser data:** Expand “Played here before?” on the join page, select your name, and ask the host to approve the seat claim. Your seat and chips move to the new phone, and the old phone immediately loses access. A name is not a credential; only the host can approve a claim.
- **Changing hosts:** On the share page, “Transfer host” displays a QR code for the next host to scan. If the host computer’s browser data was cleared, open the home page through localhost on the computer running the server and reclaim the host role there.
- **Breaks:** Select “Break” in the dock. The computer shows the break duration, phone actions pause, and the action timer stops.
- **Slow or disconnected players:** An optional action timer defaults to off and can be set from 20 to 90 seconds. Expiry **never folds automatically**; the timer ring simply turns red. Once a player is overdue or disconnected, the host can check for them if checking is legal, or fold otherwise. This requires confirmation, is recorded, and can be undone.
- **Blind increases and antes:** Set them in “More settings” when creating a room or on the seats page. Blinds can rise after a set number of hands using multipliers of 1, 2, 3, 4, 5, 6, 8, 10, and so on. The host can also move up or down one level between hands. Antes can be paid by every player or by the big blind alone.
- **Multiple all-in runouts (run it twice or three times):** Each player still in the hand chooses one, two, or three runouts. Once everyone has voted, the smallest choice wins. The host can proceed with a single runout or vote for a disconnected player who has not yet chosen. Both actions are recorded.
- **Straddles:** Off by default. When enabled by the host, the next hand’s under-the-gun player can select “Straddle next hand” between hands.
- **Digital showdown:** If any remaining player is all-in, all players still in the hand reveal their cards. At an ordinary showdown, winners reveal automatically and the other participants may choose to show.
- **Hand history:** Shows actions and pots by street, public hole cards, showdown order, and the community cards and awards for each runout. “Pots won” in a personal recap counts hands: receiving any chips on any runout counts as one hand won. “Biggest win” is all chips awarded to that player within a single hand.
- **Your turn:** Phones vibrate where supported, play a sound, and update the page title. The screen stays awake while playing; turn this off under “More” if preferred. Add the page to your home screen to return directly to the room next time.

Do not open `localhost` on a phone; that address refers to the phone itself. If the computer has multiple network interfaces, expand the address list on the start page. When no local network address is available, Yexi does not generate a placeholder QR code.

### If a phone cannot connect

- The phone and computer must use the **same Wi-Fi**. Guest networks, routers with AP or device isolation, and company or hotel networks often prevent devices from reaching one another.
- Allow incoming connections through the firewall:
  - **macOS:** Allow Node to accept incoming network connections when prompted. You can also allow it under System Settings → Network → Firewall → Options.
  - **Windows:** When Windows Security prompts you, allow access on private networks, or allow Node.js through Windows Defender Firewall. Set the network profile to private rather than public.
  - **Linux with ufw:** Replace `LAN_SUBNET` with your local network subnet, then run `sudo ufw allow from LAN_SUBNET to any port 8787 proto tcp`.
- A VPN or proxy on the computer may change its local network addresses. Turn it off and try again.

The server listens on `0.0.0.0:8787` by default and only accepts localhost and the computer’s private local network addresses as the HTTP Host. It provides no public access or tunneling. Rooms are intended for a trusted local network. Do not forward the port or proxy the service to the public internet.

Optional environment variables:

```bash
PORT=8899 npm start
DATA_FILE=/absolute/path/table.sqlite npm start
HOST=127.0.0.1 npm start  # Local debugging only; phones cannot connect
```

Windows PowerShell example: `$env:PORT=8899; npm start`.

## Browser limitations over local HTTP

The server uses plain HTTP on the local network, which browsers do not consider a secure context. These are **known limitations**, not bugs:

- **Service workers:** Cannot be registered, so the page cannot open offline. Adding it to the home screen creates a shortcut only.
- **Clipboard API:** Unavailable. Copying a recap falls back to selecting the text for copying; on a phone, you may need to press and hold to copy it manually.
- **Wake Lock:** Unavailable. Yexi falls back to looping a small silent video. Some phones may still lock the screen in power-saving mode.
- **Vibration on iOS Safari:** Unsupported. An iPhone uses sounds and page-title notifications instead.
- **Saving images:** On a phone, press and hold the displayed image to save it. On a computer, download the PNG.

HTTPS is not built in: installing a self-signed certificate on every phone is disproportionate for a local game. You can add a reverse proxy yourself, but that is outside this project’s support scope; see “Privacy and security.”

## Refreshing, disconnection, and recovery

- Rooms, chips, the current hand, logs, and the most recent 200 undo steps are stored in `data/table.sqlite`. Success is broadcast only after the SQLite WAL transaction commits. Restarting the server restores existing rooms. Older rooms without `dealMode` reopen in physical-card mode without data loss. Rooms from version 3 and earlier continue after an upgrade: the ledger is rebuilt from join, rebuy, and departure logs. Older hands lack structured records, so hand counts, VPIP, and similar statistics begin with the next hand after the upgrade, as noted in the recap.
- Each browser and access address stores separate player and host credentials. Refreshing a phone restores its seat. Changing the IP address, switching browsers, or clearing site data loses that browser’s credentials; it never automatically takes over a seat with the same name. Claim the seat on the join page and ask the host to approve it.
- Disconnected players keep their chips and place in the action. They are never folded automatically. On their turn, the host can confirm a check on their behalf, or a fold if checking is not legal. The log marks it as a host action.
- “Open table as host” on the computer’s start page uses that browser’s existing credential. If it is lost, only localhost on the computer running the server can reclaim the host role; other devices on the local network cannot.
- The share page can generate a single-use host transfer link, valid for five minutes. Once the recipient confirms, the previous host immediately loses host access. There is only one host at a time. Do not share a host transfer link as an ordinary join link.
- Phones reconnect automatically after a network interruption using exponential backoff, up to roughly 30 seconds between attempts. “Retry now” starts an immediate attempt. After reconnection, the server’s table state is authoritative.

## Data, backups, and restoration

- All data stays on the computer running the server. The default location is `data/table.sqlite`, with companion `-wal` and `-shm` files in WAL mode. Set `DATA_FILE` to change the location. The `data/` directory is in `.gitignore` and is not committed.
- **Back up:** Stop the server with Ctrl+C, then copy the entire `data/` directory, or the file named by `DATA_FILE` together with its `-wal` and `-shm` companions.
- **Restore:** Stop the server, put the backup files back in their original location, and run `npm start`.
- **Upgrade:** Stop the server, back up `data/`, update the code, run `npm ci --omit=dev`, then start the server again. Older rooms migrate automatically. Upgrade between hands where possible.
- **Clear all data:** Stop the server, then delete `data/`.
- If one room’s records are damaged, other rooms remain usable. The damaged room reports that it cannot be opened; its original database records are preserved rather than overwritten.
- Keep browser site data. The database stores credential hashes only and cannot recover a lost credential.

## Table rules

- Supports 2–10 players. The button and blinds move clockwise by seat number, skipping departed players and seats with no chips. Heads-up, the button posts the small blind and acts first before the flop; the big blind acts first after the flop.
- This is no-limit Texas Hold’em. “Raise to” means the player’s total contribution on the current street. The minimum is the current highest contribution plus the size of the last full raise. Calling chips do not count toward the raise size. A short stack may go all-in for less than a call or a full raise.
- **Short all-ins (Poker TDA Rule 49):** An all-in smaller than a full raise still requires players who have already acted to **call the additional amount or fold**, but it does not reopen raising for them. Several short all-ins reopen raising for a player once their combined increase since that player’s last action reaches a full raise. Version 4.1.0 corrected an earlier bug that did not require players who had already called to match the additional amount.
- **Straddle:** Available when at least three players participate. The next hand’s under-the-gun player—the first seat left of the big blind—may reserve a live blind of twice the current big blind. Preflop action starts to the straddler’s left, and the first full raise must reach at least four big blinds. If the straddler has fewer than two big blinds, they post their entire stack, while the nominal live blind remains two big blinds. Posting a straddle does not count toward VPIP. If the player is no longer under the gun when the hand starts, the reservation is canceled and recorded. [Robert’s Rules of Poker, section 14](https://www.homepokertourney.org/roberts-rules-of-poker.htm)
- **Big blind ante:** The big blind pays one ante at the configured level, regardless of player count. They post the blind first, then pay the ante from any remaining chips. All ante chips collected are dead money in the main pot; they do not count toward the current street’s call amount or side-pot eligibility. The default remains an ante from every player. [WSOP’s big blind ante explanation](https://www.wsop.com/news/bigger-starting-stacks-and-big-blind-ante-coming-to-2019-wsop/)
- At the end of each betting round, unmatched excess contributions are returned and recorded. Antes are dead money and are not returned. Pots are built in layers from total hand contributions. Folded chips stay in the pots, but folded players cannot win them. Adjacent layers with identical eligibility are combined.
- If only one player still has chips behind, they need only match opponents’ actual all-in contributions; they are not asked to add excess chips only to receive them back. When a table moves from three or more players to heads-up, the previous big blind becomes the button and small blind, so the same player does not post the big blind twice in a row.
- **Runout count:** The maximum can be one, two, or three; the default is three. Before the river, a vote begins only after all outstanding betting is resolved, at least two players remain, at least one is all-in, and no further betting is possible. A maximum of one proceeds directly with a single runout. With only one player left, a completed river, or betting still possible, the hand continues normally. Multiple runouts require everyone’s agreement: the smallest vote determines the count. [Robert’s Rules of Poker, section 14](https://www.homepokertourney.org/roberts-rules-of-poker.htm) · [PokerStars’ run-it-twice explanation](https://www.pokerstars.com/help/articles/run-it-twice-new/15582/)
- **Awards across runouts:** Each main or side pot is divided separately into equal integer shares. Any remainder goes one chip at a time to runout 1, then 2, then 3 until exhausted. Winners for each runout must be eligible for the original pot. If players tie within a runout, odd chips go clockwise to tied winners starting left of the button. For example, a pot of 7 split over two runouts becomes 4 and 3. If two players tie on the second runout, the winner first clockwise left of the button receives 2 and the other receives 1. With physical cards, the host selects winners for each runout and each pot. With digital cards, the app evaluates them; the host reviews the awards and odd chips before confirming. [Poker TDA split-pot and odd-chip rules](https://www.pokertda.com/view-poker-tda-rules/)
- New players can join at any time and enter on the next hand. Rebuys, adjustments, and seat removal are allowed only between hands. Only the host can enable rebuys; chips can only be added, and every addition is logged. Chips taken away by a departing player are deducted from the table total. A player who requests to leave during a hand must still act and is removed when the next hand starts.

### Deliberately unsupported

- **Dead button and dead small blind:** This home-game format uses a moving button and moving blinds, with no missed-blind payments for sitting out. The button is adjusted when moving to heads-up to avoid consecutive big blinds for one player.
- **Limit and pot-limit betting:** Yexi is designed for no-limit Texas Hold’em.
- **Timebanks:** An optional action timer is already available. The host can pause to wait for someone, or act for a player who is overdue or disconnected.
- **Missed-blind payments:** Returning players enter on the next hand.
- **Insurance:** Yexi records entertainment points only, without extra wagers or settlement.
- **Rabbit hunting:** Once betting ends, only the community cards needed to resolve the hand are dealt. [Poker TDA rules](https://www.pokertda.com/view-poker-tda-rules/)
- **Bomb pots:** Formats in which everyone contributes and skips preflop betting are outside the standard Hold’em flow.

## Digital cards and privacy

- Uses a 52-card deck without jokers. Shuffling uses Fisher–Yates with secure randomness from `node:crypto`, never `Math.random()`. Cards are dealt starting left of the button, or from the big blind heads-up. One card is burned before each community-card street; burn cards are never shown.
- Hole cards appear only in their owner’s snapshot. The host, spectators, and other players see card backs before showdown. Pre-showdown logs say only that hole cards were dealt, without ranks or suits. If everyone but one player folds, that player wins without needing to show.
- Multiple runouts share any community cards already dealt. The remaining streets are dealt in runout order from the same deck, with a burn card before each street. Newly dealt cards and burn cards are never reused across runouts. Standard best-five-of-seven Hold’em evaluation determines each pot’s winners on each runout; the host confirms the calculated result.
- An ordinary showdown starts with the last player to bet or raise on the river. If nobody bet the river, it starts with the first remaining player left of the button, then proceeds clockwise. Winners reveal automatically; others may choose to show. If any player still in the hand is all-in, all remaining players reveal. Mucked cards and their hand categories do not enter the public record. [Poker TDA showdown rules](https://www.pokertda.com/view-poker-tda-rules/)

## Sound and motion

The computer overview and phone interface both have a sound toggle. Its state is saved under the `night-table.sound` localStorage key and defaults to on. Sound begins only after the first interaction. The short WAV sounds are original to this repository and can be regenerated with `npm run sounds`. They are intended for a quiet private game, with no background music or casino ambience. When the system requests reduced motion, chip flights and card rotations are replaced with short fades. Sound remains independently controllable.

## Privacy and security

- Data stays on the computer running the server. There are no uploads, analytics, or third-party requests. Fonts, sounds, and QR codes are served locally.
- Stored data includes room settings, player-entered names, chips and ledger entries, action logs, hand histories, and credential hashes. In digital mode, the current deck and hole cards are also stored so a hand can resume after a restart. Mucked showdown cards do not appear in logs, hand histories, recaps, or anyone else’s screen, but they remain in the local database. Anyone who can read the computer’s files can access them.
- Access controls accept only localhost and the computer’s local network addresses as Host values to resist DNS rebinding. Writes require the same origin. Creating rooms and reclaiming the host role are restricted to localhost. Write endpoints and WebSocket connections are rate-limited per source.
- **Trust boundary:** Yexi is for trusted local networks. Traffic is plain HTTP, so someone able to capture traffic on the network can read it. Anyone who knows the four-character room code can watch public information. Do not use port forwarding, tunneling, or public internet exposure.
- Report security issues privately as described in [SECURITY.md](SECURITY.md).

## Verification

```bash
npm test                        # Rules, conservation, hand strength, privacy, HTTP/WebSocket, persistence, permissions
npx playwright install chromium # Install the browser used by tests the first time
npm run test:e2e                 # Real desktop and separate phone browser contexts, physical and digital cards
npm run test:all                 # Run both suites
```

If Chromium system libraries are missing on Linux, install them with `npx playwright install --with-deps chromium`. Tests use temporary databases and do not change real sessions. Browser screenshots and failure traces are written to the operating system’s temporary directory and are not committed.

Coverage includes every session-recap figure and chip-balance check; early departures and returns; seat claims from new phones; sitting out; breaks; host actions for players; antes and blind increases; mucked-card privacy; old-room migration; chip conservation; minimum raises; additional calls after short all-ins and cumulative reopening of raising; side-pot eligibility; odd chips; blind rotation and heads-up; disconnections and refresh recovery; initial-load failures and offline retry backoff; server restarts and WAL recovery; isolation of damaged data; Host, Origin, and rate-limit checks; host permissions; duplicate-request handling; step-by-step undo; decoding actual QR codes; phone controls and layout; digital shuffling and fixed hand-evaluation examples; hole-card privacy; mode changes; and legacy-data restoration. Engineering details are in the [implementation notes](docs/IMPLEMENTATION_NOTES.md); the visual foundations are documented in [Yexi design](docs/design/README.md) and [version 2](docs/design/v2.md).

## Contributing and licensing

- See [CONTRIBUTING.md](CONTRIBUTING.md) for contributions, [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community guidelines, and [CHANGELOG.md](CHANGELOG.md) for release history.
- Fonts use SIL OFL 1.1; their licenses are included under `public/fonts/`. Sounds, icons, and card artwork were created for this repository. Individual sources are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- Code and original assets are licensed under [MIT](LICENSE).
