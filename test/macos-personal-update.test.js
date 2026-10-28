const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('macOS personal updater verifies channel, checksum, bundle and atomic replacement', { skip: process.platform !== 'darwin', timeout: 60000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-update-test-'));
  t.after(() => fs.rm(dir, {recursive:true, force:true}));
  const harness = `
import Foundation
@main struct Tests {
 static func main() throws {
  let fm = FileManager.default
  let root = URL(fileURLWithPath: CommandLine.arguments[1])
  let tag = "personal-v1.4.12"
  let asset = "TokenTrackerPersonal-macOS-arm64.dmg"
  precondition(PersonalUpdateChannel.version(tag) == "1.4.12")
  for invalid in ["v1.4.12", "personal-v1.4.12-rc.1", "personal-v1.4", "personal-v1.4.12/extra"] { precondition(PersonalUpdateChannel.version(invalid) == nil) }
  let base = "https://github.com/CYRYGBG/TokenTracker/releases/download/" + tag + "/" + asset
  precondition(PersonalUpdateChannel.assetURL(base, tag:tag, name:asset) != nil)
  for invalid in [base.replacingOccurrences(of:"CYRYGBG",with:"xiufengsun"), base.replacingOccurrences(of:"https:",with:"http:"),base+"?x=1",base.replacingOccurrences(of:tag,with:"personal-v1.4.13")] { precondition(PersonalUpdateChannel.assetURL(invalid,tag:tag,name:asset) == nil) }
  let file = root.appendingPathComponent("download")
  try Data("abc".utf8).write(to:file)
  let sha = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  precondition(PersonalUpdateChannel.digest(sha+"  "+asset,name:asset) == sha)
  precondition(PersonalUpdateChannel.digest(sha+"  other.dmg",name:asset) == nil)
  let good = try PersonalUpdateChannel.verifies(file,digest:sha)
  let bad = try PersonalUpdateChannel.verifies(file,digest:String(repeating:"0",count:64))
  precondition(good && !bad)
  let source = root.appendingPathComponent("Source.app")
  let destination = root.appendingPathComponent("Installed.app")
  let contents = source.appendingPathComponent("Contents")
  try fm.createDirectory(at:contents.appendingPathComponent("MacOS"),withIntermediateDirectories:true)
  try fm.copyItem(at:URL(fileURLWithPath:"/usr/bin/true"),to:contents.appendingPathComponent("MacOS/Test"))
  let plist: [String:Any] = ["CFBundleIdentifier":PersonalUpdateChannel.bundleIdentifier,"CFBundleShortVersionString":"1.4.12","CFBundleExecutable":"Test","CFBundlePackageType":"APPL"]
  try PropertyListSerialization.data(fromPropertyList:plist,format:.xml,options:0).write(to:contents.appendingPathComponent("Info.plist"))
  let sign = Process(); sign.executableURL=URL(fileURLWithPath:"/usr/bin/codesign"); sign.arguments=["--force","--deep","--sign","-",source.path];try sign.run();sign.waitUntilExit();precondition(sign.terminationStatus == 0)
  try fm.createDirectory(at:destination,withIntermediateDirectories:true)
  try Data("old".utf8).write(to:destination.appendingPathComponent("old-marker"))
  do { try PersonalUpdateInstaller.install(source:source,destination:destination,version:"1.4.13"); fatalError("accepted wrong version") } catch { precondition(fm.fileExists(atPath:destination.appendingPathComponent("old-marker").path)) }
  try PersonalUpdateInstaller.install(source:source,destination:destination,version:"1.4.12")
  precondition(!fm.fileExists(atPath:destination.appendingPathComponent("old-marker").path))
  precondition(Bundle(url:destination)?.bundleIdentifier == PersonalUpdateChannel.bundleIdentifier)
  // Mutating a signed resource must fail without damaging the installed app.
  try Data("corrupt".utf8).write(to:contents.appendingPathComponent("MacOS/Test"))
  do { try PersonalUpdateInstaller.install(source:source,destination:destination,version:"1.4.12");fatalError("accepted corrupt bundle") } catch { precondition(fm.fileExists(atPath:destination.appendingPathComponent("Contents/MacOS/Test").path)) }
  precondition(try fm.contentsOfDirectory(atPath:root.path).allSatisfy { !$0.contains("-update-") })
  print("personal updater checks passed")
 }
}
`;
  const main = path.join(dir,'Harness.swift');
  await fs.writeFile(main,harness.replace('precondition(try fm.contentsOfDirectory(atPath:root.path).allSatisfy { !$0.contains("-update-") })','let leftovers = try fm.contentsOfDirectory(atPath:root.path); precondition(leftovers.allSatisfy { !$0.contains("-update-") })'));
  const models = path.resolve(__dirname,'../TokenTrackerBar/TokenTrackerBar/Models');
  const executable = path.join(dir,'verify');
  execFileSync('/usr/bin/swiftc',['-parse-as-library',path.join(models,'PersonalUpdateChannel.swift'),path.join(models,'PersonalUpdateInstaller.swift'),main,'-o',executable],{stdio:'pipe',timeout:45000});
  assert.match(execFileSync(executable,[dir],{encoding:'utf8',timeout:15000}),/checks passed/);
});
