import Foundation
import Speech

@main struct SpeechTranscriptionTests {
    static func main() throws {
        let options = try SpeechTranscriptionOptions.parse(["--input", "/tmp/local.m4a", "--output-directory", "/tmp/owned", "--locale", "en-US", "--track", "microphone", "--offset", "1.25", "--contextual-string", "REVA"])
        precondition(options.offset == 1.25 && options.contextualStrings == ["REVA"])
        for invalid in [
            ["--input", "relative.m4a", "--output-directory", "/tmp/owned", "--locale", "en-US", "--track", "system"],
            ["--input", "/tmp/local.m4a", "--output-directory", "/tmp/owned", "--locale", "en-US", "--track", "cloud"],
            ["--input", "/tmp/local.m4a", "--output-directory", "/tmp/owned", "--locale", "en-US", "--track", "system", "--offset", "nan"],
            ["--download-model", "true"],
            ["--locale", "en-US", "--locale", "de-DE"]
        ] {
            do { _ = try SpeechTranscriptionOptions.parse(invalid); fatalError("Invalid speech options accepted") }
            catch let failure as CaptureFailure { precondition(failure.code == "invalid_arguments") }
        }
        let request = SpeechTranscriptionCommand.request(url: options.input, contextualStrings: options.contextualStrings)
        precondition(request.requiresOnDeviceRecognition)
        precondition(!request.shouldReportPartialResults)
        precondition(request.contextualStrings == ["REVA"])
        let before = SFSpeechRecognizer.authorizationStatus()
        let status = SpeechTranscriptionCommand.status(locale: "en-US")
        precondition(status.method == "apple-on-device" && status.engine.contains("legacy"))
        precondition(SFSpeechRecognizer.authorizationStatus() == before, "Status must not request permission")
        precondition(!status.locales.isEmpty)
        ProtocolOutput.emit(["type": "tests-passed", "coverage": "option parsing, mandatory local-only request, permission-free status; no speech recognition or model installation performed"])
        ProtocolOutput.emit(status)
    }
}
