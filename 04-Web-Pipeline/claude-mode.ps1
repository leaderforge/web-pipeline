$tokenPath = "$env:USERPROFILE\.claude-token"

if (-not (Test-Path $tokenPath)) {
    Write-Host "❌ No se encontró el token. Crea el archivo en: $tokenPath" -ForegroundColor Red
    return
}

# Limpia variables heredadas de deepseek-mode
Remove-Item Env:\ANTHROPIC_BASE_URL -ErrorAction SilentlyContinue
Remove-Item Env:\ANTHROPIC_MODEL -ErrorAction SilentlyContinue
Remove-Item Env:\ANTHROPIC_DEFAULT_OPUS_MODEL -ErrorAction SilentlyContinue
Remove-Item Env:\ANTHROPIC_DEFAULT_SONNET_MODEL -ErrorAction SilentlyContinue
Remove-Item Env:\ANTHROPIC_DEFAULT_HAIKU_MODEL -ErrorAction SilentlyContinue
Remove-Item Env:\CLAUDE_CODE_SUBAGENT_MODEL -ErrorAction SilentlyContinue
Remove-Item Env:\CLAUDE_CODE_EFFORT_LEVEL -ErrorAction SilentlyContinue

$env:ANTHROPIC_AUTH_TOKEN = (Get-Content $tokenPath -Raw).Trim()

Write-Host "✅ Modo Claude activado" -ForegroundColor Green