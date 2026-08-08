FROM node:22-alpine

RUN npm install -g @aipost/mcp-server

ENV AIPOST_API_KEY=""

ENTRYPOINT ["aipost-mcp-server"]
