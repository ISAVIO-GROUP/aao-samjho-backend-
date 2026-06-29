aao-samjho-backend/
├── vercel.json          ← NEW
├── package.json         ← REPLACE old one
├── lib/
│   └── utils.js         ← NEW (shared code)
└── api/
    ├── health.js        ← NEW
    ├── auth/
    │   ├── login.js     ← NEW
    │   └── verify.js    ← NEW
    ├── ai/
    │   ├── chat.js      ← NEW
    │   ├── notes.js     ← NEW
    │   └── test.js      ← NEW
    └── keys/
        ├── index.js     ← NEW
        └── [id].js      ← NEW
