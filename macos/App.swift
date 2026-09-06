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

class Fetcher: ObservableObject {
    @Published var snapshots: [QuotaSnapshot] = []
    @Published var isRefreshing = false
    @Published var lastError: String? = nil
    @Published var isBuildingReport = false

    /// Generate the usage report and hand it to the default browser.
    ///
    /// The window is generous because it bounds what the report's own time-range
    /// picker can reach — narrowing happens in the page, not here.
    func openReport(days: Int = 30) {
        DispatchQueue.main.async {
            self.isBuildingReport = true
            self.lastError = nil
        }

        DispatchQueue.global(qos: .userInitiated).async {
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/bin/bash")
            // Same PATH injection as refresh(): a WindowServer app does not
            // inherit a login shell, so neither npx/node nor the collector
            // binaries (agy, codex, both in ~/.local/bin) are on PATH.
            task.arguments = ["-c", "export PATH=\"$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\" && cd /Users/mingjianliu/code/quotacheck-mcp && npx tsx scripts/report.ts --days \(days)"]

            let pipe = Pipe()
            let errPipe = Pipe()
            task.standardOutput = pipe
            task.standardError = errPipe

            do {
                try task.run()
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
                task.waitUntilExit()

                guard task.terminationStatus == 0 else {
                    let errStr = String(data: errData, encoding: .utf8) ?? "Unknown"
                    DispatchQueue.main.async {
                        self.lastError = "Report failed (\(task.terminationStatus)): \(errStr.prefix(200))"
                        self.isBuildingReport = false
                    }
                    return
                }

                // The script prints the written path on its last line.
                let outStr = String(data: data, encoding: .utf8) ?? ""
                let path = outStr
                    .components(separatedBy: .newlines)
                    .map { $0.trimmingCharacters(in: .whitespaces) }
                    .last(where: { $0.hasSuffix(".html") })

                DispatchQueue.main.async {
                    self.isBuildingReport = false
                    guard let path, FileManager.default.fileExists(atPath: path) else {
                        self.lastError = "Report path not found in output."
                        return
                    }
                    NSWorkspace.shared.open(URL(fileURLWithPath: path))
                }
            } catch {
                DispatchQueue.main.async {
                    self.lastError = error.localizedDescription
                    self.isBuildingReport = false
                }
            }
        }
    }
    
    func refresh(force: Bool = false) {
        // Run on main thread for UI updates
        DispatchQueue.main.async {
            self.isRefreshing = true
            self.lastError = nil
        }
        
        DispatchQueue.global(qos: .userInitiated).async {
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/bin/bash")
            // Inject the paths a WindowServer app lacks: Homebrew for npx and
            // node, ~/.local/bin for the agy and codex CLIs the collectors run.
            let forceArg = force ? " --force" : ""
            task.arguments = ["-c", "export PATH=\"$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\" && cd /Users/mingjianliu/code/quotacheck-mcp && npx tsx scripts/export-json.ts\(forceArg)"]
            
            let pipe = Pipe()
            let errPipe = Pipe()
            task.standardOutput = pipe
            task.standardError = errPipe
            
            do {
                try task.run()
                task.waitUntilExit()
                
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
                
                if task.terminationStatus == 0 {
                    do {
                        let rawStr = String(data: data, encoding: .utf8) ?? ""
                        // Find the first line that looks like a JSON array
                        let jsonLine = rawStr.components(separatedBy: .newlines).first(where: { 
                            $0.trimmingCharacters(in: .whitespaces).hasPrefix("[") && 
                            $0.trimmingCharacters(in: .whitespaces).hasSuffix("]")
                        })?.trimmingCharacters(in: .whitespaces)
                        
                        guard let validJson = jsonLine else {
                            throw NSError(domain: "Quotacheck", code: 1, userInfo: [NSLocalizedDescriptionKey: "No valid JSON found in output."])
                        }
                        
                        let decoder = JSONDecoder()
                        let result = try decoder.decode([QuotaSnapshot].self, from: validJson.data(using: .utf8)!)
                        DispatchQueue.main.async {
                            self.snapshots = result
                            self.isRefreshing = false
                        }
                    } catch {
                        let rawStr = String(data: data, encoding: .utf8) ?? "binary data"
                        print("Parse error: \(error)")
                        print("Raw data: \(rawStr)")
                        DispatchQueue.main.async {
                            self.lastError = "Parse error: \(error.localizedDescription)\nData: \(rawStr.prefix(200))"
                            self.isRefreshing = false
                        }
                    }
                } else {
                    let errStr = String(data: errData, encoding: .utf8) ?? "Unknown"
                    DispatchQueue.main.async {
                        self.lastError = "Command failed (\(task.terminationStatus)): \(errStr)"
                        self.isRefreshing = false
                    }
                }
            } catch {
                DispatchQueue.main.async {
                    self.lastError = error.localizedDescription
                    self.isRefreshing = false
                }
            }
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
            if let err = fetcher.lastError {
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
                    Text("Auto-refreshes every 5m")
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
        .onAppear {
            fetcher.refresh(force: true)
            Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { _ in
                fetcher.refresh(force: true)
            }
        }
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
