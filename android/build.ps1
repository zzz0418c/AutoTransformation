param(
    [string]$Jdk = $env:JAVA_HOME,
    [switch]$Install,
    [switch]$Launch
)

$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { $env:ANDROID_SDK_ROOT }

if (-not $sdk -or -not (Test-Path $sdk)) {
    throw 'ANDROID_HOME / ANDROID_SDK_ROOT is not set or does not exist.'
}

if (-not $Jdk -or -not (Test-Path (Join-Path $Jdk 'bin\javac.exe'))) {
    $candidates = @(
        'C:\Program Files\Eclipse Adoptium\jdk-17*\bin\javac.exe',
        'C:\Program Files\Java\jdk-17*\bin\javac.exe',
        "$env:LOCALAPPDATA\Programs\Eclipse Adoptium\jdk-17*\bin\javac.exe",
        "$env:LOCALAPPDATA\Programs\Microsoft\jdk-17*\bin\javac.exe"
    )
    foreach ($pattern in $candidates) {
        $hit = Get-ChildItem $pattern -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($hit) {
            $Jdk = Split-Path (Split-Path $hit.FullName -Parent) -Parent
            break
        }
    }
}

if (-not $Jdk -or -not (Test-Path (Join-Path $Jdk 'bin\javac.exe'))) {
    throw 'JDK 17 not found. Set JAVA_HOME or pass -Jdk "C:\path\to\jdk-17".'
}

$buildTools = Join-Path $sdk 'build-tools\34.0.0'
if (-not (Test-Path (Join-Path $buildTools 'aapt2.exe'))) {
    $buildTools = Get-ChildItem (Join-Path $sdk 'build-tools') -Directory |
        Sort-Object { [version]$_.Name } -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}

$platform = Join-Path $sdk 'platforms\android-34'
if (-not (Test-Path (Join-Path $platform 'android.jar'))) {
    $platform = Get-ChildItem (Join-Path $sdk 'platforms') -Directory |
        Where-Object { $_.Name -match '^android-\d+$' } |
        Sort-Object { [int]($_.Name -replace 'android-', '') } -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}

$androidJar = Join-Path $platform 'android.jar'
if (-not (Test-Path $androidJar)) { throw "android.jar not found under $platform" }

$env:JAVA_HOME = $Jdk
$env:Path = (Join-Path $Jdk 'bin') + ';' + $buildTools + ';' + $env:Path

$build = Join-Path $root 'build'
$gen = Join-Path $build 'gen'
$classes = Join-Path $build 'classes'
$dex = Join-Path $build 'dex'
$resZip = Join-Path $build 'res.zip'
$unsigned = Join-Path $build 'app-unsigned.apk'
$aligned = Join-Path $build 'app-aligned.apk'
$apk = Join-Path $build 'AutoTransformation-tablet.apk'

if (Test-Path $build) { Remove-Item -LiteralPath $build -Recurse -Force }
New-Item -ItemType Directory -Force -Path $gen, $classes, $dex | Out-Null

function Invoke-Tool {
    param([string]$File, [string[]]$Arguments)
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code $LASTEXITCODE`: $File"
    }
}

Write-Host '==> aapt2 compile'
Invoke-Tool -File (Join-Path $buildTools 'aapt2.exe') -Arguments @(
    'compile', '--dir', (Join-Path $root 'res'), '-o', $resZip
)

Write-Host '==> aapt2 link'
Invoke-Tool -File (Join-Path $buildTools 'aapt2.exe') -Arguments @(
    'link',
    '-o', $unsigned,
    '-I', $androidJar,
    '--manifest', (Join-Path $root 'AndroidManifest.xml'),
    '-R', $resZip,
    '--java', $gen,
    '--auto-add-overlay'
)

Write-Host '==> javac'
$javaSources = @(Get-ChildItem (Join-Path $root 'src') -Recurse -Filter *.java | Select-Object -ExpandProperty FullName)
$rjava = @(Get-ChildItem $gen -Recurse -Filter R.java | Select-Object -ExpandProperty FullName)
if (-not $javaSources.Count) { throw 'No Java sources found.' }
if (-not $rjava.Count) { throw 'R.java was not generated.' }

Invoke-Tool -File (Join-Path $Jdk 'bin\javac.exe') -Arguments (@(
    '-encoding', 'UTF-8',
    '-source', '8',
    '-target', '8',
    '-classpath', $androidJar,
    '-d', $classes
) + $javaSources + $rjava)

Write-Host '==> jar + d8'
$classesJar = Join-Path $build 'classes.jar'
Invoke-Tool -File (Join-Path $Jdk 'bin\jar.exe') -Arguments @('cf', $classesJar, '-C', $classes, '.')
Invoke-Tool -File (Join-Path $buildTools 'd8.bat') -Arguments @(
    '--lib', $androidJar,
    '--min-api', '24',
    '--output', $dex,
    $classesJar
)

Write-Host '==> package + zipalign'
Invoke-Tool -File (Join-Path $Jdk 'bin\jar.exe') -Arguments @('uf', $unsigned, '-C', $dex, 'classes.dex')
Invoke-Tool -File (Join-Path $buildTools 'zipalign.exe') -Arguments @('-f', '4', $unsigned, $aligned)

Write-Host '==> sign'
$keystore = Join-Path $env:USERPROFILE '.android\debug.keystore'
if (-not (Test-Path $keystore)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $keystore) | Out-Null
    Invoke-Tool -File (Join-Path $Jdk 'bin\keytool.exe') -Arguments @(
        '-genkeypair', '-v',
        '-keystore', $keystore,
        '-storepass', 'android',
        '-alias', 'androiddebugkey',
        '-keypass', 'android',
        '-keyalg', 'RSA',
        '-keysize', '2048',
        '-validity', '10000',
        '-dname', 'CN=Android Debug,O=Android,C=US'
    )
}

Invoke-Tool -File (Join-Path $buildTools 'apksigner.bat') -Arguments @(
    'sign',
    '--ks', $keystore,
    '--ks-pass', 'pass:android',
    '--key-pass', 'pass:android',
    '--out', $apk,
    $aligned
)
Invoke-Tool -File (Join-Path $buildTools 'apksigner.bat') -Arguments @('verify', '--verbose', $apk)

$dist = Join-Path (Split-Path $root -Parent) 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$final = Join-Path $dist 'AutoTransformation-tablet.apk'
Copy-Item -LiteralPath $apk -Destination $final -Force

Write-Host ''
Write-Host "APK: $final"
Write-Host ("Size: {0:N1} KB" -f ((Get-Item $final).Length / 1KB))

if ($Install) {
    $adb = Join-Path $sdk 'platform-tools\adb.exe'
    Write-Host '==> adb install'
    Invoke-Tool -File $adb -Arguments @('install', '-r', $final)
    Write-Host '==> adb reverse tcp:8787'
    Invoke-Tool -File $adb -Arguments @('reverse', 'tcp:8787', 'tcp:8787')

    if ($Launch) {
        Write-Host '==> launch'
        Invoke-Tool -File $adb -Arguments @(
            'shell', 'am', 'start', '-n',
            'com.zzz0418c.autotransformation/.MainActivity'
        )
    }
}

exit 0
