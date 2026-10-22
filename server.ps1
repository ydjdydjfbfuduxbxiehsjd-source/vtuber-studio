# VTuber Studio Pro - Built-in Windows Native Server
# Runs out-of-the-box on ANY Windows machine without Node.js or Python!

$distDir = Join-Path $PSScriptRoot "dist"
if (-not (Test-Path $distDir)) {
    Write-Host "[ERROR] dist folder not found!" -ForegroundColor Red
    Pause
    exit 1
}

$port = 5173
$listener = $null

while ($port -lt 5200) {
    try {
        $listener = New-Object System.Net.HttpListener
        $listener.Prefixes.Add("http://127.0.0.1:$port/")
        $listener.Start()
        break
    } catch {
        $listener = $null
        $port++
    }
}

if (-not $listener) {
    Write-Host "[ERROR] Could not bind port for server." -ForegroundColor Red
    Pause
    exit 1
}

$url = "http://127.0.0.1:$port/"
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "   VTuber Studio Pro - Server Started!" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "   Browser URL: $url" -ForegroundColor Yellow
Write-Host "   Running via Windows native HTTP engine." -ForegroundColor Gray
Write-Host "   Close this window to stop the server." -ForegroundColor Gray
Write-Host "============================================================`n" -ForegroundColor Cyan

try {
    Start-Process $url
} catch {}

$mimeMap = @{
    ".html"     = "text/html; charset=utf-8"
    ".js"       = "application/javascript; charset=utf-8"
    ".mjs"      = "application/javascript; charset=utf-8"
    ".css"      = "text/css; charset=utf-8"
    ".json"     = "application/json; charset=utf-8"
    ".svg"      = "image/svg+xml"
    ".png"      = "image/png"
    ".jpg"      = "image/jpeg"
    ".jpeg"     = "image/jpeg"
    ".ico"      = "image/x-icon"
    ".wasm"     = "application/wasm"
    ".data"     = "application/octet-stream"
    ".tflite"   = "application/octet-stream"
    ".vrm"      = "application/octet-stream"
    ".binarypb" = "application/octet-stream"
}

try {
    while ($listener.IsListening) {
        $ctx = $listener.GetContext()
        
        try {
            $req = $ctx.Request
            $res = $ctx.Response

            $res.AddHeader("Access-Control-Allow-Origin", "*")
            $res.AddHeader("Cross-Origin-Opener-Policy", "same-origin")
            $res.AddHeader("Cross-Origin-Embedder-Policy", "require-corp")

            $rawUrl = $req.Url.LocalPath
            if ($rawUrl -eq "/" -or [string]::IsNullOrWhiteSpace($rawUrl)) {
                $rawUrl = "/index.html"
            }

            $relPath = $rawUrl.TrimStart("/").Replace("/", [System.IO.Path]::DirectorySeparatorChar)
            $filePath = Join-Path $distDir $relPath

            if (-not (Test-Path $filePath -PathType Leaf)) {
                $filePath = Join-Path $distDir "index.html"
            }

            if (Test-Path $filePath -PathType Leaf) {
                $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
                $ctype = if ($mimeMap.ContainsKey($ext)) { $mimeMap[$ext] } else { "application/octet-stream" }
                $res.ContentType = $ctype

                $bytes = [System.IO.File]::ReadAllBytes($filePath)
                $res.ContentLength64 = $bytes.Length
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            } else {
                $res.StatusCode = 404
            }
        } catch {
            # Catch client disconnects/aborts gracefully without crashing loop
        } finally {
            try { $ctx.Response.Close() } catch {}
        }
    }
} catch {
    Write-Host "[INFO] Server stopped: $_" -ForegroundColor Yellow
} finally {
    if ($listener) {
        try { $listener.Stop() } catch {}
        try { $listener.Close() } catch {}
    }
}
