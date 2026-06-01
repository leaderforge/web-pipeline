# Lee la API key desde un archivo seguro fuera del repo
$tokenPath = "$env:USERPROFILE\.deepseek-token"

if (-not (Test-Path $tokenPath)) {
    Write-Host "❌ No se encontró el token. Crea el archivo en: $tokenPath" -ForegroundColor Red
    return
}

$env:ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic"
$env:ANTHROPIC_AUTH_TOKEN = (Get-Content $tokenPath -Raw).Trim()
$env:ANTHROPIC_MODEL = "deepseek-v4-pro"
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = "deepseek-v4-pro"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = "deepseek-v4-pro"
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = "deepseek-v4-flash"
$env:CLAUDE_CODE_SUBAGENT_MODEL = "deepseek-v4-flash"
$env:CLAUDE_CODE_EFFORT_LEVEL = "max"

Write-Host "✅ Modo DeepSeek activado" -ForegroundColor Green
