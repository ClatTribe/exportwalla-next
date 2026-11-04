// Interactive API docs (Swagger UI) for the public API.
const SWAGGER = "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.33.3";

const HTML = `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link type="text/css" rel="stylesheet" href="${SWAGGER}/swagger-ui.css">
<link rel="icon" href="/favicon.svg">
<title>Exportwalla - Swagger UI</title>
</head>
<body>
<div id="swagger-ui"></div>
<script src="${SWAGGER}/swagger-ui-bundle.js"></script>
<script>
const ui = SwaggerUIBundle({
  url: "/openapi.json", dom_id: "#swagger-ui", layout: "BaseLayout", deepLinking: true, showExtensions: true,
  showCommonExtensions: true, presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
});
</script>
</body>
</html>
`;

export function GET() {
  return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
}
