# @agentgit/authority-sdk

TypeScript client SDK for the local-first `agentgit` authority daemon.

## Install

```bash
npm install @agentgit/authority-sdk @agentgit/schemas
```

## Compatibility

- Node.js `24.14.0+`
- local daemon API `authority.v1`

## Example

```ts
import { AuthorityClient } from "@agentgit/authority-sdk";

const client = new AuthorityClient({
  socketPath: "/absolute/path/to/authority.sock",
});

const hello = await client.hello(["/absolute/path/to/workspace"]);
console.log(hello.accepted_api_version);
```
