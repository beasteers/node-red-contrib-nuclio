# Dev Info

## Test Environment

```bash
docker-compose up -d --build
```

 * Node-RED: http://localhost:1882
 * Nuclio dashboard: http://localhost:8072

Unit tests and lint:

```bash
npm test
npm run lint
```

## Notes

For testing message rates during redeploys, you should use "Deploy: Modified nodes"
mode so that your interval nodes will continue publishing at a different rate.
Otherwise any variations that you see could be attributed to interval resets.
