#!/usr/bin/env python3
"""Build the Pintos Test Explorer VSIX without external tooling."""

from __future__ import annotations

import json
from pathlib import Path
from xml.sax.saxutils import escape
import zipfile


REPO_ROOT = Path(__file__).resolve().parent.parent
EXTENSION_DIR = REPO_ROOT / "extension"
DIST_DIR = REPO_ROOT / "dist"


def load_package() -> dict:
    with (EXTENSION_DIR / "package.json").open("r", encoding="utf-8") as handle:
        return json.load(handle)


def normalize_link(value) -> str:
    if isinstance(value, dict):
        return value.get("url", "")
    return value or ""


def manifest_xml(pkg: dict) -> str:
    repository_url = escape(normalize_link(pkg.get("repository")))
    bugs_url = escape(normalize_link(pkg.get("bugs")))
    homepage = escape(pkg.get("homepage", ""))
    keywords = escape(",".join(pkg.get("keywords", [])))
    categories = escape(",".join(pkg.get("categories", [])))
    dependencies = escape(",".join(pkg.get("extensionDependencies", [])))
    extension_kind = escape(",".join(pkg.get("extensionKind", [])))
    icon_path = escape(f"extension/{pkg['icon']}")
    banner_color = escape(pkg.get("galleryBanner", {}).get("color", "#0b1220"))

    return f"""<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{escape(pkg['name'])}" Version="{escape(pkg['version'])}" Publisher="{escape(pkg['publisher'])}" />
    <DisplayName>{escape(pkg['displayName'])}</DisplayName>
    <Description xml:space="preserve">{escape(pkg['description'])}</Description>
    <Tags>{keywords}</Tags>
    <Categories>{categories}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{escape(pkg['engines']['vscode'])}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="{dependencies}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="{extension_kind}" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.EnabledApiProposals" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="{repository_url}" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Getstarted" Value="{repository_url}" />
      <Property Id="Microsoft.VisualStudio.Services.Links.GitHub" Value="{repository_url}" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Support" Value="{bugs_url}" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Learn" Value="{homepage}" />
      <Property Id="Microsoft.VisualStudio.Services.Branding.Color" Value="{banner_color}" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free" />
    </Properties>
    <License>extension/LICENSE.txt</License>
    <Icon>{icon_path}</Icon>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/readme.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/changelog.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="{icon_path}" Addressable="true" />
  </Assets>
</PackageManifest>
"""


CONTENT_TYPES_XML = """<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".md" ContentType="text/markdown" />
  <Default Extension=".png" ContentType="image/png" />
  <Default Extension=".py" ContentType="application/octet-stream" />
  <Default Extension=".sh" ContentType="application/octet-stream" />
  <Default Extension=".svg" ContentType="image/svg+xml" />
  <Default Extension=".txt" ContentType="text/plain" />
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
</Types>
"""


def archive_members(pkg: dict) -> list[tuple[Path, str]]:
    members = [(EXTENSION_DIR / "package.json", "extension/package.json")]
    for relative in pkg.get("files", []):
        source = EXTENSION_DIR / relative
        target_name = relative
        if relative == "README.md":
            target_name = "readme.md"
        elif relative == "CHANGELOG.md":
            target_name = "changelog.md"
        members.append((source, f"extension/{target_name}"))
    return members


def build_vsix(output_path: Path, pkg: dict) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("extension.vsixmanifest", manifest_xml(pkg))
        archive.writestr("[Content_Types].xml", CONTENT_TYPES_XML)
        for source, target in archive_members(pkg):
            archive.write(source, target)


def main() -> int:
    pkg = load_package()
    artifact_name = f"{pkg['name']}-{pkg['version']}.vsix"
    output = DIST_DIR / artifact_name
    legacy_output = EXTENSION_DIR / artifact_name

    build_vsix(output, pkg)
    print(f"built {output}")

    if legacy_output.exists():
        legacy_output.unlink()
        print(f"removed legacy artifact {legacy_output}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
