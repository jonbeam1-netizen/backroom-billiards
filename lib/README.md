# lib: libraries kept with the game

Every library is a file in this folder at one pinned version. Nothing is loaded from the internet at run time (build rule 2).

| File | What | Version | Licence | From | Date |
|---|---|---|---|---|---|
| three.module.min.js | three.js, the 3D drawing library | 0.170.0 (r170) | MIT (three.LICENSE.txt) | https://unpkg.com/three@0.170.0/build/three.module.min.js | 2026-11-22 |
| peerjs.min.js | PeerJS, connects the two players straight to each other for the join code | 1.5.4 | MIT (peerjs.LICENSE.txt) | https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js | 2026-11-23 |

PeerJS is the one part of the game that talks to the outside: its free public service (0.peerjs.com) introduces the two players to each other, and a public address-finding server helps them connect. After that the two PCs talk directly.
