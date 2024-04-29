module Docgen = Tools_Docgen

/** Returns the full file system path to the `rescript-tools` binary for the current platform, side stepping the JS that wraps the CLI.
 
 You can use this when you're already running a JS process and want to avoid the overhead of starting another one.

 ## Examples
 ```rescript
 // Prints the current ReScript Tools version.
 let stringifiedJson = ChildProcess.execFileSync(RescriptTools.getBinaryPath(), ["-v"])
 ```
 */
@module("./getBinaryPath.js")
external getBinaryPath: unit => string = "getBinaryPath"
