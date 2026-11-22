#requires -Version 5.1
<#
  Build the signed PULSE/LAB APK (controller + Phira trigger mode).

  Requirements:
    - JDK 17 (JAVA_HOME)
    - Android SDK with platforms;android-35, build-tools;35.0.0;
      Gradle will download the ML Kit OCR dependencies on first build.
    - Network access on the first build (Gradle + ML Kit).

  Example:
    powershell -ExecutionPolicy Bypass -File scripts/build-apk.ps1 `
      -JdkHome C:\tools\jdk-17 `
      -AndroidSdk C:\Android\Sdk

  The APK is signed with android/keystore/pulselab-debug.keystore so it can
  update an existing PULSE/LAB sideload install. For public distribution,
  replace the signing config with your own release keystore.
#>
param(
    [string]$JdkHome = $env:JAVA_HOME,
    [string]$AndroidSdk = $env:ANDROID_SDK_ROOT,
    [string]$Output = ""
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$androidRoot = Join-Path $root "android"
$gradlew = Join-Path $androidRoot "gradlew.bat"
$apkSource = Join-Path $androidRoot "build\outputs\apk\release\PulseLab-release.apk"

if (-not $Output) {
    $Output = Join-Path $root "dist\PULSE-LAB-1.1.4.apk"
}

if (-not $JdkHome) {
    throw "JAVA_HOME (JDK 17+) is required. Pass -JdkHome <path>."
}
if (-not (Test-Path -LiteralPath (Join-Path $JdkHome "bin\javac.exe"))) {
    throw "JdkHome must point to a full JDK 17+, not a JRE: $JdkHome"
}
if (-not $AndroidSdk) {
    throw "Android SDK is required. Pass -AndroidSdk <path> or set ANDROID_SDK_ROOT."
}
if (-not (Test-Path -LiteralPath $gradlew)) {
    throw "Missing Gradle wrapper: $gradlew"
}

$env:JAVA_HOME = $JdkHome
$env:ANDROID_HOME = $AndroidSdk
$env:ANDROID_SDK_ROOT = $AndroidSdk

# Keep the SDK location in the conventional local file for Gradle/Studio.
$localProperties = Join-Path $androidRoot "local.properties"
$sdkValue = $AndroidSdk.Replace('\', '\\').Replace(':', '\:')
Set-Content -LiteralPath $localProperties -Value "sdk.dir=$sdkValue" -Encoding ASCII

Push-Location $androidRoot
try {
    Write-Host "==> gradlew :assembleRelease"
    & $gradlew --console=plain :assembleRelease
    if ($LASTEXITCODE -ne 0) {
        throw "Gradle build failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

if (-not (Test-Path -LiteralPath $apkSource)) {
    throw "Gradle did not produce $apkSource"
}

$outDir = Split-Path -Parent $Output
if (-not (Test-Path -LiteralPath $outDir)) {
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null
}
Copy-Item -LiteralPath $apkSource -Destination $Output -Force
$hash = (Get-FileHash -LiteralPath $Output -Algorithm SHA256).Hash.ToLower()
$shaFile = "$Output.sha256"
Set-Content -LiteralPath $shaFile -Value "$hash  $(Split-Path -Leaf $Output)" -Encoding ASCII

Write-Host ""
Write-Host "APK: $Output"
Write-Host "SHA-256: $hash"
Write-Host "SHA file: $shaFile"
