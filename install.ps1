# Copies the Glossy Glass theme into Steam's Millennium skins folder.
# Run again after editing the CSS (run build.ps1 first if you changed the generated
# parts), then restart Steam or reload the theme in Millennium.
#   -Startup   also start the Steam Glass helper when you sign in to Windows
param([switch]$Startup)
$steam = (Get-ItemProperty "HKCU:\Software\Valve\Steam").SteamPath -replace "/", "\"
$dest = Join-Path $steam "steamui\skins\GlossyGlass"
New-Item -ItemType Directory -Force $dest | Out-Null
$files = "skin.json", "libraryroot.custom.css", "friends.custom.css", "glass-frosted.css", "glass-clear.css",
         "liquid.css", "liquid.js"
Copy-Item ($files | ForEach-Object { Join-Path $PSScriptRoot $_ }) $dest -Force
"Installed theme to $dest"

if ($Startup) {
    $pythonw = (Get-Command pythonw.exe -ErrorAction Stop).Source
    $lnk = Join-Path ([Environment]::GetFolderPath("Startup")) "Steam Glass helper.lnk"
    $s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
    $s.TargetPath = $pythonw
    $s.Arguments = '"' + (Join-Path $PSScriptRoot "steamglass.pyw") + '"'
    $s.WorkingDirectory = $PSScriptRoot
    $s.Save()
    "Helper starts at sign-in: $lnk"
}
