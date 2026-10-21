import SwiftUI
import Foundation

// MARK: - Panel data (`quotacheck panel`)

/// The CLI works everything out (burn rates, projections, colours); the app only draws.
struct PanelData: Decodable {
    let generatedAt: String
    let storageError: String?
    let headline: Headline?
    let sources: [PanelSource]
}

struct Headline: Decodable {
    let source: String
    let label: String
    let pct: Double
    let tier: String
}

struct PanelAccount: Decodable {
    let label: String?
    let plan: String?
}

struct SourceError: Decodable {
    let kind: String
    let message: String
}

struct ResetCredits: Decodable {
    let available: Int
    let firstExpiresAt: String?
}

struct PanelWindow: Decodable, Identifiable {
    let id: String
    let label: String
    /// Shared-limit group heading ("Gemini Models"); `label` then names the window alone.
    let groupLabel: String?
    let kind: String
    let pct: Double
    let tier: String
    let resetsAt: String?
    let burnPerHour: Double?
    let projectedPct: Double?
    let runsOutAt: String?
    let used: Double?
    let limit: Double?
    let unit: String?
    let currency: String?
}

struct PanelSource: Decodable, Identifiable {
    let source: String
    let name: String
    let account: PanelAccount?
    let observedAt: String?
    let ageMs: Double?
    let freshness: String
    let error: SourceError?
    let nextAllowedAt: String?
    let windows: [PanelWindow]
    let resetCredits: ResetCredits?
    var id: String { source }
}

/// `quotacheck refresh`: what the service did with the request.
struct RefreshReply: Decodable {
    struct Item: Decodable {
        let source: String
        let status: String
        let nextAllowedAt: String?
        let reason: String?
    }
    let results: [Item]
}

/// Outcome of one `quotacheck` invocation.
struct CLIResult {
    let status: Int32
    let stdout: Data
    let stderr: Data
}

enum QuotacheckCLI {
    /// PATH for child processes.
    ///
    /// A GUI app inherits launchd's minimal PATH, so `quotacheck` installed with
    /// nvm, volta, fnm or asdf (and the `node` its shebang needs) is invisible.
    /// The user's login shell knows the real PATH; ask it once and keep the
    /// common install locations as a fallback.
    static let searchPath: String = {
        let home = NSHomeDirectory()
        let fallback = [
            "\(home)/.local/bin", "\(home)/.volta/bin", "\(home)/.asdf/shims",
            "\(home)/.local/share/fnm/aliases/default/bin", "\(home)/.nvm/current/bin",
            "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
        ]
        var parts: [String] = []
        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        let marker = "__QUOTACHECK_PATH__"
        if let out = try? QuotacheckCLI.run(URL(fileURLWithPath: shell),
                              ["-ilc", "printf '\(marker)%s\(marker)' \"$PATH\""],
                              path: nil, timeout: 5),
           out.status == 0,
           let text = String(data: out.stdout, encoding: .utf8),
           let start = text.range(of: marker),
           let end = text.range(of: marker, range: start.upperBound..<text.endIndex) {
            parts = text[start.upperBound..<end.lowerBound].split(separator: ":").map(String.init)
        }
        for p in fallback + (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
        where !parts.contains(p) {
            parts.append(p)
        }
        return parts.joined(separator: ":")
    }()

    static func quotacheck(_ args: [String]) throws -> CLIResult {
        try QuotacheckCLI.run(URL(fileURLWithPath: "/usr/bin/env"), ["quotacheck"] + args, path: QuotacheckCLI.searchPath, timeout: 60)
    }

    /// Run a child to completion, draining stdout and stderr concurrently so a
    /// chatty child can never block on a full pipe while we wait for it.
    static func run(_ executable: URL, _ args: [String], path: String?, timeout: TimeInterval) throws -> CLIResult {
        let task = Process()
        task.executableURL = executable
        task.arguments = args
        if let path {
            var env = ProcessInfo.processInfo.environment
            env["PATH"] = path
            task.environment = env
        }
        let outPipe = Pipe(), errPipe = Pipe()
        task.standardOutput = outPipe
        task.standardError = errPipe
        task.standardInput = FileHandle.nullDevice
        try task.run()

        // A box rather than a captured var: Dispatch closures are @Sendable.
        final class Box { var data = Data() }
        let err = Box()
        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global(qos: .utility).async {
            err.data = errPipe.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        let killer = DispatchWorkItem { if task.isRunning { task.terminate() } }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout, execute: killer)
        let out = outPipe.fileHandleForReading.readDataToEndOfFile()
        group.wait()
        task.waitUntilExit()
        killer.cancel()
        return CLIResult(status: task.terminationStatus, stdout: out, stderr: err.data)
    }
}

// MARK: - Fetching

class Fetcher: ObservableObject {
    @Published var panel: PanelData? = nil
    @Published var isRefreshing = false
    @Published var lastError: String? = nil
    @Published var reportError: String? = nil
    /// What the service said about the last manual refresh.
    @Published var notice: String? = nil
    @Published var isBuildingReport = false
    private var pollTimer: Timer?
    /// Main-thread only. A poll is skipped while one is still running, so a slow
    /// CLI cannot pile up processes.
    private var inFlight = 0

    /// The view only reads stored observations; the service collects every few minutes.
    static let pollInterval: TimeInterval = 30

    init() {
        // The menu bar title shows the headline, so polling runs whether or not the panel is open.
        startPolling()
    }

    func startPolling() {
        guard pollTimer == nil else { return }
        load()
        pollTimer = Timer.scheduledTimer(withTimeInterval: Fetcher.pollInterval, repeats: true) { [weak self] _ in
            self?.load()
        }
    }

    /// Generate the usage report and hand it to the default browser.
    ///
    /// The window is generous because it bounds what the report's own time-range
    /// picker can reach — narrowing happens in the page, not here.
    func openReport(days: Int = 30) {
        DispatchQueue.main.async {
            self.isBuildingReport = true
            self.reportError = nil
        }

        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let result = try QuotacheckCLI.quotacheck(["report", "--days", String(days)])

                guard result.status == 0 else {
                    let errStr = String(data: result.stderr, encoding: .utf8) ?? "Unknown"
                    DispatchQueue.main.async {
                        self.reportError = "Report failed (\(result.status)): \(errStr.prefix(200))"
                        self.isBuildingReport = false
                    }
                    return
                }

                // The CLI prints the written path on its last line.
                let outStr = String(data: result.stdout, encoding: .utf8) ?? ""
                let path = outStr
                    .components(separatedBy: .newlines)
                    .map { $0.trimmingCharacters(in: .whitespaces) }
                    .last(where: { $0.hasSuffix(".html") })

                DispatchQueue.main.async {
                    self.isBuildingReport = false
                    guard let path = path, FileManager.default.fileExists(atPath: path) else {
                        self.reportError = "Report path not found in output."
                        return
                    }
                    NSWorkspace.shared.open(URL(fileURLWithPath: path))
                }
            } catch {
                DispatchQueue.main.async {
                    self.reportError = error.localizedDescription
                    self.isBuildingReport = false
                }
            }
        }
    }

    /// Ask the service to collect, say what it answered, and read again once it has had time to.
    func refresh() {
        DispatchQueue.main.async {
            self.notice = nil
            self.isRefreshing = true
        }
        DispatchQueue.global(qos: .userInitiated).async {
            var text: String
            var accepted = false
            do {
                let result = try QuotacheckCLI.quotacheck(["refresh"])
                if result.status == 0, let reply = try? JSONDecoder().decode(RefreshReply.self, from: Fetcher.lastJSONLine(result.stdout)) {
                    accepted = reply.results.contains { $0.status == "accepted" || $0.status == "coalesced" }
                    text = Fetcher.summarise(reply.results)
                } else {
                    text = "Refresh failed: \(String(data: result.stderr, encoding: .utf8)?.prefix(200) ?? "")"
                }
            } catch {
                text = error.localizedDescription
            }
            // Constants, not captured vars: Dispatch closures are @Sendable.
            let message = text, wasAccepted = accepted
            DispatchQueue.main.async {
                self.notice = message
                self.isRefreshing = false
                self.load()
                // Collection runs in the background; most sources answer within seconds.
                if wasAccepted {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 8) { self.load() }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 25) { self.load() }
                }
            }
        }
    }

    static func summarise(_ items: [RefreshReply.Item]) -> String {
        if items.contains(where: { $0.status == "unavailable" && ($0.reason ?? "").contains("service unavailable") }) {
            return "Quota service is not running — run quotacheck install-service"
        }
        let parts = items.compactMap { item -> String? in
            let name = Fetcher.shortName(item.source)
            switch item.status {
            case "accepted", "coalesced": return "\(name) collecting"
            case "deferred":
                if let next = item.nextAllowedAt.flatMap(parseISO) { return "\(name) next at \(clock(next))" }
                return "\(name) waiting (\(item.reason ?? "cooldown"))"
            case "unavailable": return "\(name): \(item.reason ?? "unavailable")"
            default: return nil
            }
        }
        return parts.joined(separator: " · ")
    }

    static func shortName(_ source: String) -> String {
        switch source {
        case "claude-code": return "Claude"
        case "gemini-web": return "Gemini"
        case "antigravity": return "Antigravity"
        case "codex": return "Codex"
        default: return source
        }
    }

    static func lastJSONLine(_ data: Data) -> Data {
        let text = String(data: data, encoding: .utf8) ?? ""
        let line = text.components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .last(where: { $0.hasPrefix("{") && $0.hasSuffix("}") }) ?? ""
        return Data(line.utf8)
    }

    /// Read the panel model. Errors keep the last good panel on screen.
    func load() {
        DispatchQueue.main.async {
            if self.inFlight > 0 { return }
            self.inFlight += 1
            DispatchQueue.global(qos: .userInitiated).async { self.read() }
        }
    }

    private func read() {
        var panel: PanelData? = nil
        var failure: String? = nil
        do {
            let result = try QuotacheckCLI.quotacheck(["panel"])
            if result.status == 0 {
                do {
                    panel = try JSONDecoder().decode(PanelData.self, from: Fetcher.lastJSONLine(result.stdout))
                } catch {
                    let raw = String(data: result.stdout, encoding: .utf8) ?? ""
                    failure = "Parse error: \(error.localizedDescription)\nData: \(raw.prefix(200))"
                }
            } else {
                let errStr = String(data: result.stderr, encoding: .utf8) ?? "Unknown"
                failure = "Command failed (\(result.status)): \(errStr.prefix(500))"
            }
        } catch {
            failure = error.localizedDescription
        }
        let fresh = panel, message = failure
        DispatchQueue.main.async {
            if let fresh = fresh { self.panel = fresh }
            self.lastError = message
            self.inFlight -= 1
        }
    }
}

// MARK: - Formatting

func parseISO(_ s: String) -> Date? {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.date(from: s) ?? ISO8601DateFormatter().date(from: s)
}

func clock(_ date: Date) -> String {
    let f = DateFormatter()
    f.dateFormat = "HH:mm"
    return f.string(from: date)
}

/// "2h 05m" within a day, "Tue 05:32" further out.
func resetText(_ date: Date, now: Date = Date()) -> String {
    let diff = date.timeIntervalSince(now)
    if diff <= 0 { return "now" }
    let h = Int(diff) / 3600
    let m = (Int(diff) % 3600) / 60
    if h >= 24 {
        let f = DateFormatter()
        f.dateFormat = "EEE HH:mm"
        return f.string(from: date)
    }
    return h > 0 ? "\(h)h \(String(format: "%02d", m))m" : "\(m)m"
}

func ageText(_ ms: Double) -> String {
    let s = Int(ms / 1000)
    if s < 60 { return "just now" }
    if s < 3600 { return "\(s / 60)m ago" }
    if s < 86400 { return "\(s / 3600)h ago" }
    return "\(s / 86400)d ago"
}

func shortDate(_ date: Date) -> String {
    let f = DateFormatter()
    f.dateFormat = "d MMM"
    return f.string(from: date)
}

func number(_ v: Double) -> String {
    v >= 10 || v == v.rounded() ? String(format: "%.0f", v) : String(format: "%.1f", v)
}

// MARK: - Palette

enum Palette {
    static let ok = Color(red: 0.24, green: 0.84, blue: 0.47)
    static let warn = Color(red: 0.99, green: 0.80, blue: 0.22)
    static let critical = Color(red: 0.97, green: 0.33, blue: 0.33)
    static let panel = Color(red: 0.06, green: 0.06, blue: 0.07)
    static let card = Color.white.opacity(0.045)
    static let track = Color.white.opacity(0.10)
    static let secondary = Color.white.opacity(0.55)
    static let tertiary = Color.white.opacity(0.35)

    static func tier(_ tier: String) -> Color {
        switch tier {
        case "critical": return critical
        case "warn": return warn
        default: return ok
        }
    }

    static func source(_ source: String) -> Color {
        switch source {
        case "claude-code": return Color(red: 0.85, green: 0.47, blue: 0.34)
        case "codex": return Color(red: 0.55, green: 0.85, blue: 0.75)
        case "antigravity": return Color(red: 0.55, green: 0.55, blue: 0.98)
        case "gemini-web": return Color(red: 0.40, green: 0.62, blue: 0.98)
        default: return Color.gray
        }
    }

    static func icon(_ source: String) -> String {
        switch source {
        case "claude-code": return "asterisk"
        case "codex": return "chevron.left.forwardslash.chevron.right"
        case "antigravity": return "triangle"
        case "gemini-web": return "sparkles"
        default: return "circle"
        }
    }
}

enum ValueMode: String, CaseIterable, Identifiable {
    case percent = "%"
    case burn = "%/h"
    var id: String { rawValue }
}

// MARK: - Views

/// A thin bar: solid to the current level, faint on to where the current pace lands at the reset.
struct QuotaBar: View {
    let pct: Double
    let projected: Double?
    let color: Color

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let now = CGFloat(min(max(pct, 0), 100) / 100) * w
            let ahead = CGFloat(min(max(projected ?? pct, pct), 100) / 100) * w
            ZStack(alignment: .leading) {
                Capsule().fill(Palette.track)
                if ahead > now {
                    Capsule().fill(color.opacity(0.32)).frame(width: ahead)
                }
                Capsule().fill(color).frame(width: max(now, pct > 0 ? 3 : 0))
            }
        }
        .frame(height: 5)
    }
}

struct WindowRow: View {
    let window: PanelWindow
    let mode: ValueMode

    private var color: Color { Palette.tier(window.tier) }

    private var valueText: String {
        if let used = window.used, let limit = window.limit, window.unit != nil {
            let symbol = window.unit == "currency" && (window.currency ?? "USD") == "USD" ? "$" : ""
            return "\(symbol)\(String(format: "%.2f", used)) / \(symbol)\(String(format: "%.0f", limit))"
        }
        if mode == .burn {
            guard let rate = window.burnPerHour else { return "—" }
            if rate < 0.05 { return "0%/h" }
            return "\(String(format: rate < 10 ? "%.1f" : "%.0f", rate))%/h"
        }
        return "\(number(window.pct))%"
    }

    private var trailing: (String, Color) {
        if let out = window.runsOutAt.flatMap(parseISO) {
            return ("runs out \(clock(out))", color)
        }
        if mode == .burn, let projected = window.projectedPct {
            return ("\(number(projected))% by reset", Palette.secondary)
        }
        if let reset = window.resetsAt.flatMap(parseISO) {
            // A weekly reset days away is a date; under pressure it takes the row's colour.
            return (resetText(reset), window.tier == "ok" ? Palette.secondary : color)
        }
        return ("", Palette.secondary)
    }

    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(window.label)
                .font(.system(size: 12.5, weight: .medium))
                .foregroundColor(.white)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 6)
            QuotaBar(pct: window.pct, projected: window.projectedPct, color: color)
                .frame(width: 92)
            Text(valueText)
                .font(.system(size: 12.5, weight: .semibold, design: .rounded).monospacedDigit())
                .foregroundColor(color)
                .lineLimit(1)
                .frame(width: window.unit != nil ? 112 : 54, alignment: .trailing)
            // A spend limit has no reset to count down to; its amount takes the room.
            if window.unit == nil {
                Text(trailing.0)
                    .font(.system(size: 11).monospacedDigit())
                    .foregroundColor(trailing.1)
                    .lineLimit(1)
                    .frame(width: 84, alignment: .trailing)
            }
        }
        .help(helpText)
    }

    private var helpText: String {
        var parts = ["\(window.label): \(number(window.pct))% used"]
        if let rate = window.burnPerHour { parts.append("\(String(format: "%.1f", rate))%/h over the last hours") }
        if let projected = window.projectedPct { parts.append("\(number(projected))% at reset at this pace") }
        if let reset = window.resetsAt.flatMap(parseISO) {
            let f = DateFormatter()
            f.dateStyle = .medium
            f.timeStyle = .short
            parts.append("resets \(f.string(from: reset))")
        }
        return parts.joined(separator: "\n")
    }
}

struct SourceSection: View {
    let source: PanelSource
    let mode: ValueMode

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: Palette.icon(source.source))
                    .font(.system(size: 11, weight: .bold))
                    .foregroundColor(Palette.source(source.source))
                    .frame(width: 22, height: 22)
                    .background(Palette.source(source.source).opacity(0.16))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                Text(source.name)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(.white)
                Spacer()
                statusBadge
            }
            if let account = source.account, let text = account.label ?? account.plan {
                HStack {
                    Text(text)
                        .font(.system(size: 11))
                        .foregroundColor(Palette.secondary)
                        .lineLimit(1)
                    Spacer()
                    if source.freshness == "stale", let observed = source.observedAt.flatMap(parseISO) {
                        Text("last read \(resetTextPast(observed))")
                            .font(.system(size: 11))
                            .foregroundColor(Palette.warn.opacity(0.85))
                    }
                }
            }
            if let error = source.error {
                VStack(alignment: .leading, spacing: 2) {
                    Text(error.message)
                        .font(.system(size: 11))
                        .foregroundColor(error.kind == "authentication" ? Palette.warn : Palette.critical.opacity(0.9))
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                    if let next = source.nextAllowedAt.flatMap(parseISO), next > Date() {
                        Text("Retrying at \(clock(next))")
                            .font(.system(size: 10.5))
                            .foregroundColor(Palette.tertiary)
                    }
                }
            }
            if source.windows.isEmpty && source.error == nil {
                Text(source.freshness == "missing" ? "No reading yet" : "No quota windows reported")
                    .font(.system(size: 11))
                    .foregroundColor(Palette.tertiary)
            }
            ForEach(Array(source.windows.enumerated()), id: \.element.id) { index, window in
                if let heading = window.groupLabel, index == 0 || source.windows[index - 1].groupLabel != heading {
                    Text(heading)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(Palette.secondary)
                        .padding(.top, index == 0 ? 0 : 2)
                }
                WindowRow(window: window, mode: mode)
            }
            if let credits = source.resetCredits, credits.available > 0 {
                HStack(spacing: 8) {
                    Image(systemName: "arrow.counterclockwise")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(Palette.secondary)
                        .frame(width: 7)
                    Text("Usage resets")
                        .font(.system(size: 12.5))
                        .foregroundColor(Palette.secondary)
                    Spacer()
                    Text("\(credits.available) available")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(Palette.ok)
                    if let first = credits.firstExpiresAt.flatMap(parseISO) {
                        Text("first expires \(shortDate(first))")
                            .font(.system(size: 11))
                            .foregroundColor(Palette.secondary)
                    }
                }
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12).fill(Palette.card))
    }

    @ViewBuilder private var statusBadge: some View {
        if source.error != nil {
            Image(systemName: source.error?.kind == "authentication" ? "person.crop.circle.badge.exclamationmark" : "exclamationmark.triangle.fill")
                .font(.system(size: 11))
                .foregroundColor(source.error?.kind == "authentication" ? Palette.warn : Palette.critical)
        } else if let age = source.ageMs {
            Text(ageText(age))
                .font(.system(size: 11).monospacedDigit())
                .foregroundColor(Palette.tertiary)
        }
    }

    private func resetTextPast(_ date: Date) -> String {
        ageText(Date().timeIntervalSince(date) * 1000)
    }
}

struct ContentView: View {
    @ObservedObject var fetcher: Fetcher
    @AppStorage("valueMode") private var modeRaw: String = ValueMode.percent.rawValue

    private var mode: ValueMode { ValueMode(rawValue: modeRaw) ?? .percent }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            if let err = fetcher.lastError ?? fetcher.reportError ?? fetcher.panel?.storageError {
                Text(err)
                    .font(.system(size: 11))
                    .foregroundColor(Palette.critical)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Palette.critical.opacity(0.12)))
            }
            if let panel = fetcher.panel {
                ScrollView {
                    VStack(spacing: 8) {
                        ForEach(panel.sources) { source in
                            SourceSection(source: source, mode: mode)
                        }
                    }
                }
            } else {
                VStack(spacing: 10) {
                    ProgressView().controlSize(.small)
                    Text("Reading quotas…")
                        .font(.system(size: 12))
                        .foregroundColor(Palette.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            footer
        }
        .padding(14)
        .frame(width: 430, height: 620)
        .background(Palette.panel)
        .environment(\.colorScheme, .dark)
        .onAppear { fetcher.load() }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Text("Quotas")
                .font(.system(size: 15, weight: .bold))
                .foregroundColor(.white)
            Spacer()
            Picker("", selection: $modeRaw) {
                ForEach(ValueMode.allCases) { m in
                    Text(m.rawValue).tag(m.rawValue)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 96)
            .help("Show the share used, or how fast it is being used")
            Button(action: { fetcher.refresh() }) {
                if fetcher.isRefreshing {
                    ProgressView().controlSize(.small).scaleEffect(0.7).frame(width: 16, height: 16)
                } else {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundColor(Palette.secondary)
                        .frame(width: 16, height: 16)
                }
            }
            .buttonStyle(.plain)
            .disabled(fetcher.isRefreshing)
            .help("Ask the service to collect now (it respects each source's cooldown)")
        }
    }

    private var footer: some View {
        HStack(spacing: 10) {
            Text(fetcher.notice ?? updatedText)
                .font(.system(size: 10.5))
                .foregroundColor(Palette.tertiary)
                .lineLimit(2)
            Spacer()
            Button(action: { fetcher.openReport() }) {
                HStack(spacing: 4) {
                    if fetcher.isBuildingReport {
                        ProgressView().scaleEffect(0.4).frame(width: 10, height: 10)
                    } else {
                        Image(systemName: "chart.bar.xaxis").font(.system(size: 10))
                    }
                    Text(fetcher.isBuildingReport ? "Building…" : "History")
                }
            }
            .buttonStyle(.plain)
            .disabled(fetcher.isBuildingReport)
            .font(.system(size: 11, weight: .medium))
            .foregroundColor(Palette.secondary)
            Button("Quit") { NSApplication.shared.terminate(nil) }
                .buttonStyle(.plain)
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(Palette.secondary)
        }
    }

    private var updatedText: String {
        guard let at = fetcher.panel.flatMap({ parseISO($0.generatedAt) }) else { return "" }
        return "Updated \(clock(at)) · every \(Int(Fetcher.pollInterval))s"
    }
}

/// The menu bar shows the quota under most pressure, as agent-hud's glow does.
struct MenuBarLabel: View {
    @ObservedObject var fetcher: Fetcher

    var body: some View {
        if let headline = fetcher.panel?.headline {
            HStack(spacing: 3) {
                Image(systemName: headline.tier == "critical" ? "exclamationmark.triangle.fill" : "gauge")
                Text("\(Int(headline.pct.rounded()))%")
            }
        } else {
            Image(systemName: "gauge")
        }
    }
}

@main
struct QuotacheckApp: App {
    @StateObject private var fetcher = Fetcher()

    var body: some Scene {
        MenuBarExtra {
            ContentView(fetcher: fetcher)
        } label: {
            MenuBarLabel(fetcher: fetcher)
        }
        .menuBarExtraStyle(.window)
    }
}
