# ulda-crud

Simple ULDA CRUD server backed by MySQL. It auto-starts a local MySQL Docker container if no DB is reachable.

## Quick start
1. Install deps: npm install
2. Run: npm run dev
3. Open: http://localhost:8787/browser-test/

## Database
Table `main`:
- id: BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY
- ulda_key: BLOB
- content: LONGBLOB
Engine: InnoDB

## REST API
POST /records
Body:
{
  "ulda_key": "<hex or base64>",
  "content": "<base64>",
  "format": "hex",
  "contentFormat": "base64"
}

GET /records/:id?format=hex&contentFormat=base64

PUT /records/:id
Body:
{
  "ulda_key": "<hex or base64>",
  "content": "<base64>",
  "format": "hex",
  "contentFormat": "base64"
}

DELETE /records/:id
Body:
{
  "ulda_key": "<hex or base64>",
  "format": "hex"
}

## Socket.IO events
- create
- read
- update
- delete

Payloads match REST bodies.
