# PowerShell 5.1/7 入口，防止原生命令的 UTF-8 JSON 被本机代码页错误解码。
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    [Console]::Error.WriteLine('未找到 Node.js，请先安装 Node.js 24+。')
    exit 2
}
& node (Join-Path $PSScriptRoot 'cli.mjs') @args
exit $LASTEXITCODE
