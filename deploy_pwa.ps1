$ErrorActionPreference = "Stop"

Write-Host "Lese GitHub Token..."
$token = (Get-Content github_token.txt).Trim()
if (-not $token) {
    Write-Host "Fehler: github_token.txt ist leer!"
    exit 1
}

$repoUrl = "https://$($token)@github.com/Dr4gon3ater/aether-streaming.git"
$buildDir = "pwa-build"

Write-Host "Erstelle PWA Build-Ordner..."
if (Test-Path $buildDir) { Remove-Item -Recurse -Force $buildDir }
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null

Write-Host "Kopiere Web-Dateien..."
# Kopiere nur die für die Web-App nötigen Dateien
Copy-Item index.html $buildDir
Copy-Item manifest.json $buildDir
Copy-Item service-worker.js $buildDir
Copy-Item -Recurse css $buildDir
Copy-Item -Recurse js $buildDir
Copy-Item -Recurse assets $buildDir

Write-Host "Pushe auf GitHub Pages (gh-pages Branch)..."
Set-Location $buildDir

& "C:\Program Files\Git\cmd\git.exe" init
& "C:\Program Files\Git\cmd\git.exe" config user.name "Aether PWA Bot"
& "C:\Program Files\Git\cmd\git.exe" config user.email "bot@aether"
& "C:\Program Files\Git\cmd\git.exe" checkout -b gh-pages

& "C:\Program Files\Git\cmd\git.exe" add .
& "C:\Program Files\Git\cmd\git.exe" commit -m "Deploy PWA"

& "C:\Program Files\Git\cmd\git.exe" remote add origin $repoUrl
Write-Host "Lade auf GitHub hoch (das kann ein paar Sekunden dauern)..."
& "C:\Program Files\Git\cmd\git.exe" push -f origin gh-pages

Set-Location ..
Remove-Item -Recurse -Force $buildDir

Write-Host "Erfolgreich! Die App ist in wenigen Minuten verfügbar unter:"
Write-Host "https://dr4gon3ater.github.io/aether-streaming/"
