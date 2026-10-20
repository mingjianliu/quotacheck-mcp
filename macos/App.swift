import SwiftUI
import Foundation

struct QuotaUsage: Codable, Hashable {
    let used: Double
    let limit: Double
    let pct: Double
    let resetsAt: String?
}

struct SubModelBucket: Codable, Hashable {
    let name: String
    let used: Double
    let limit: Double
    let pct: Double
    let resetsAt: String?
}

struct QuotaSnapshot: Codable, Hashable {
    let source: String
    let collectedAt: String
    let error: String?
    let session: QuotaUsage?
    let weekly: QuotaUsage?
    let subModels: [SubModelBucket]?
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

class Fetcher: ObservableObject {
    @Published var snapshots: [QuotaSnapshot] = []
    @Published var isRefreshing = false
    @Published var lastError: String? = nil
    @Published var reportError: String? = nil
    @Published var isBuildingReport = false
    private var pollTimer: Timer?
    /// Main-thread only. A poll is skipped while one is still running, so a slow
    /// CLI cannot pile up processes.
    private var inFlight = 0

    /// The view only reads stored observations; the service collects every few minutes.
    static let pollInterval: TimeInterval = 30

    func startPolling() {
        guard pollTimer == nil else { return }
        refresh()
        pollTimer = Timer.scheduledTimer(withTimeInterval: Fetcher.pollInterval, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }

    func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
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

    /// Read stored quotas. `force` also asks the service to collect; it answers
    /// asynchronously, so its readings arrive on a later poll.
    func refresh(force: Bool = false) {
        DispatchQueue.main.async {
            // A manual refresh still goes through: the service coalesces requests.
            if self.inFlight > 0 && !force { return }
            self.inFlight += 1
            self.isRefreshing = true
            DispatchQueue.global(qos: .userInitiated).async { self.load(force: force) }
        }
    }

    private func load(force: Bool) {
        var snapshots: [QuotaSnapshot]? = nil
        var failure: String? = nil
        do {
            let result = try QuotacheckCLI.quotacheck(["legacy"] + (force ? ["--refresh"] : []))
            if result.status == 0 {
                let rawStr = String(data: result.stdout, encoding: .utf8) ?? ""
                // Find the first line that looks like a JSON array
                let jsonLine = rawStr.components(separatedBy: .newlines)
                    .map { $0.trimmingCharacters(in: .whitespaces) }
                    .first(where: { $0.hasPrefix("[") && $0.hasSuffix("]") })
                if let validJson = jsonLine, let data = validJson.data(using: .utf8) {
                    do {
                        snapshots = try JSONDecoder().decode([QuotaSnapshot].self, from: data)
                    } catch {
                        failure = "Parse error: \(error.localizedDescription)\nData: \(rawStr.prefix(200))"
                    }
                } else {
                    failure = "No valid JSON found in output.\nData: \(rawStr.prefix(200))"
                }
            } else {
                let errStr = String(data: result.stderr, encoding: .utf8) ?? "Unknown"
                failure = "Command failed (\(result.status)): \(errStr.prefix(500))"
            }
        } catch {
            failure = error.localizedDescription
        }
        DispatchQueue.main.async {
            if let snapshots { self.snapshots = snapshots }
            self.lastError = failure
            self.inFlight -= 1
            self.isRefreshing = self.inFlight > 0
        }
    }
}

struct CustomProgressBar: View {
    let value: Double // 0 to 100
    
    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(Color.primary.opacity(0.08))
                    .frame(height: 6)
                
                Capsule()
                    .fill(
                        LinearGradient(
                            colors: fillColors(for: value),
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                    .frame(width: CGFloat(min(value, 100.0) / 100.0) * geometry.size.width, height: 6)
            }
        }
        .frame(height: 6)
    }
    
    private func fillColors(for pct: Double) -> [Color] {
        if pct > 90 {
            return [Color.red, Color.orange]
        } else if pct > 75 {
            return [Color.orange, Color.yellow]
        } else {
            return [Color.blue, Color.indigo]
        }
    }
}

struct ContentView: View {
    @StateObject var fetcher = Fetcher()
    
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Header
            HStack {
                HStack(spacing: 8) {
                    ZStack {
                        Circle()
                            .fill(LinearGradient(colors: [.blue, .purple], startPoint: .topLeading, endPoint: .bottomTrailing))
                            .frame(width: 28, height: 28)
                        Image(systemName: "chart.pie.fill")
                            .font(.system(size: 13))
                            .foregroundColor(.white)
                    }
                    Text("AI Quotas")
                        .font(.system(.title3, design: .rounded))
                        .fontWeight(.bold)
                }
                Spacer()
                
                if fetcher.isRefreshing {
                    ProgressView()
                        .controlSize(.small)
                        .scaleEffect(0.8)
                } else {
                    Button(action: {
                        withAnimation {
                            fetcher.refresh(force: true)
                        }
                    }) {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundColor(.secondary)
                            .padding(6)
                            .background(Color.primary.opacity(0.05))
                            .clipShape(Circle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.bottom, 4)
            
            // Error Message (if execution/fetch fails)
            if let err = fetcher.lastError ?? fetcher.reportError {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundColor(.red)
                        .font(.subheadline)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("System Error")
                            .font(.system(.caption, design: .rounded))
                            .fontWeight(.bold)
                            .foregroundColor(.red)
                        Text(err)
                            .foregroundColor(.red.opacity(0.8))
                            .font(.system(.caption2, design: .rounded))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(10)
                .background(Color.red.opacity(0.08))
                .cornerRadius(8)
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(Color.red.opacity(0.15), lineWidth: 1)
                )
            }
            
            // Loading State or Data View
            ZStack {
                if fetcher.snapshots.isEmpty && fetcher.isRefreshing && fetcher.lastError == nil {
                    VStack(spacing: 12) {
                        ProgressView()
                            .controlSize(.regular)
                        Text("Fetching quota statistics...")
                            .font(.system(.subheadline, design: .rounded))
                            .foregroundColor(.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if fetcher.snapshots.isEmpty && !fetcher.isRefreshing && fetcher.lastError == nil {
                    VStack(spacing: 10) {
                        Image(systemName: "chart.bar.doc.horizontal")
                            .font(.system(size: 32))
                            .foregroundColor(.secondary)
                        Text("No data available")
                            .font(.system(.subheadline, design: .rounded))
                            .fontWeight(.medium)
                            .foregroundColor(.secondary)
                        Button("Refresh Now") {
                            fetcher.refresh(force: true)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            ForEach(fetcher.snapshots, id: \.source) { snap in
                                SourceView(snap: snap)
                            }
                        }
                        .padding(.vertical, 2)
                        .padding(.trailing, 4)
                    }
                }
            }
            .frame(maxHeight: .infinity)
            
            Divider()
                .background(Color.primary.opacity(0.08))
            
            // Footer
            HStack {
                HStack(spacing: 4) {
                    Image(systemName: "arrow.triangle.2.circlepath")
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)
                    Text("Background collection · view updates every \(Int(Fetcher.pollInterval))s")
                        .font(.system(.caption2, design: .rounded))
                        .foregroundColor(.secondary)
                }
                Spacer()
                Button(action: { fetcher.openReport() }) {
                    HStack(spacing: 4) {
                        if fetcher.isBuildingReport {
                            ProgressView()
                                .scaleEffect(0.4)
                                .frame(width: 10, height: 10)
                        } else {
                            Image(systemName: "chart.xyaxis.line")
                                .font(.system(size: 10))
                        }
                        Text(fetcher.isBuildingReport ? "Building…" : "History")
                    }
                }
                .buttonStyle(.plain)
                .disabled(fetcher.isBuildingReport)
                .font(.system(.caption, design: .rounded))
                .fontWeight(.medium)
                .foregroundColor(.secondary)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(Color.primary.opacity(0.05))
                .cornerRadius(6)

                Button("Quit") {
                    NSApplication.shared.terminate(nil)
                }
                .buttonStyle(.plain)
                .font(.system(.caption, design: .rounded))
                .fontWeight(.medium)
                .foregroundColor(.secondary)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(Color.primary.opacity(0.05))
                .cornerRadius(6)
            }
        }
        .padding(16)
        .frame(width: 360, height: 480) // Set a fixed width and height so it never collapses and gets cut off
        .onAppear { fetcher.startPolling() }
        .onDisappear { fetcher.stopPolling() }
    }
}

struct SourceView: View {
    let snap: QuotaSnapshot
    @State private var isExpanded: Bool = true
    
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button(action: {
                withAnimation(.spring(response: 0.3, dampingFraction: 0.7)) {
                    isExpanded.toggle()
                }
            }) {
                HStack(spacing: 8) {
                    Image(systemName: sourceIcon(for: snap.source))
                        .foregroundColor(sourceColor(for: snap.source))
                        .font(.system(size: 12, weight: .bold))
                        .frame(width: 24, height: 24)
                        .background(sourceColor(for: snap.source).opacity(0.12))
                        .cornerRadius(6)
                    
                    Text(formatSourceName(snap.source))
                        .font(.system(.subheadline, design: .rounded))
                        .fontWeight(.bold)
                    
                    Spacer()
                    
                    if snap.error != nil {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundColor(.red)
                            .font(.caption)
                    }
                    
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(.secondary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            
            if isExpanded {
                VStack(alignment: .leading, spacing: 12) {
                    if let err = snap.error {
                        HStack(alignment: .top, spacing: 6) {
                            Image(systemName: "xmark.octagon.fill")
                                .foregroundColor(.red)
                                .font(.caption)
                            Text(err)
                                .foregroundColor(.red.opacity(0.9))
                                .font(.system(.caption, design: .rounded))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(.vertical, 4)
                    } else {
                        if let sess = snap.session {
                            QuotaBar(name: "Session Quota", usage: sess)
                        }
                        if let weekly = snap.weekly {
                            QuotaBar(name: "Weekly Quota", usage: weekly)
                        }
                        if let subs = snap.subModels, !subs.isEmpty {
                            ForEach(subs, id: \.name) { sub in
                                QuotaBar(name: sub.name, used: sub.used, limit: sub.limit, pct: sub.pct, resetsAt: sub.resetsAt)
                            }
                        }
                        if snap.session == nil && snap.weekly == nil && (snap.subModels == nil || snap.subModels!.isEmpty) {
                            Text("No quota limits found.")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                    }
                }
                .padding(.leading, 4)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(Color.primary.opacity(0.02))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color.primary.opacity(0.06), lineWidth: 1)
        )
    }
    
    private func sourceIcon(for source: String) -> String {
        switch source.lowercased() {
        case "claude-code": return "terminal.fill"
        case "gemini-web": return "globe"
        case "antigravity": return "bolt.fill"
        case "codex": return "chevron.left.forwardslash.chevron.right"
        default: return "sparkles"
        }
    }

    private func sourceColor(for source: String) -> Color {
        switch source.lowercased() {
        case "claude-code": return Color(red: 0.9, green: 0.45, blue: 0.3)
        case "gemini-web": return Color.teal
        case "antigravity": return Color.purple
        case "codex": return Color.green
        default: return Color.indigo
        }
    }
    
    private func formatSourceName(_ source: String) -> String {
        switch source.lowercased() {
        case "claude-code": return "Claude Code"
        case "gemini-web": return "Gemini Web"
        case "antigravity": return "Antigravity"
        case "codex": return "Codex"
        default: return source.split(separator: "-").map { $0.capitalized }.joined(separator: " ")
        }
    }
    
    private func formatDate(_ isoString: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: isoString) ?? ISO8601DateFormatter().date(from: isoString) {
            let outFormatter = DateFormatter()
            outFormatter.timeStyle = .short
            return outFormatter.string(from: date)
        }
        return ""
    }
}

struct QuotaBar: View {
    let name: String
    let used: Double
    let limit: Double
    let pct: Double
    let resetsAt: String?

    init(name: String, usage: QuotaUsage) {
        self.name = name
        self.used = usage.used
        self.limit = usage.limit
        self.pct = usage.pct
        self.resetsAt = usage.resetsAt
    }

    init(name: String, used: Double, limit: Double, pct: Double, resetsAt: String? = nil) {
        self.name = name
        self.used = used
        self.limit = limit
        self.pct = pct
        self.resetsAt = resetsAt
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(name.capitalized)
                    .font(.system(.caption, design: .rounded))
                    .fontWeight(.medium)
                    .foregroundColor(.primary.opacity(0.8))
                Spacer()
                Text(limit == 100 ? "\(Int(used))%" : "\(Int(used)) / \(Int(limit))")
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundColor(.secondary)
            }
            
            CustomProgressBar(value: pct)
            
            if let resetsAt = resetsAt, let resetDate = parseISO(resetsAt) {
                HStack(spacing: 3) {
                    Image(systemName: "clock")
                        .font(.system(size: 8))
                    Text("Resets \(formatReset(resetDate))")
                        .font(.system(size: 9, weight: .regular, design: .rounded))
                }
                .foregroundColor(.secondary.opacity(0.8))
                .padding(.top, 1)
            }
        }
    }

    func parseISO(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: s) ?? ISO8601DateFormatter().date(from: s)
    }

    func formatReset(_ date: Date) -> String {
        let now = Date()
        let diff = date.timeIntervalSince(now)
        if diff <= 0 { return "now" }
        let h = Int(diff) / 3600
        let m = (Int(diff) % 3600) / 60
        if h >= 24 {
            let fmt = DateFormatter()
            fmt.dateFormat = "MMM d 'at' h:mm a"
            return fmt.string(from: date)
        }
        if h > 0 { return "in \(h)h \(m)m" }
        return "in \(m)m"
    }
}

@main
struct QuotacheckApp: App {
    var body: some Scene {
        MenuBarExtra("Quota", systemImage: "chart.pie.fill") {
            ContentView()
        }
        .menuBarExtraStyle(.window)
    }
}
