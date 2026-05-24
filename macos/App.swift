import SwiftUI
import Foundation

struct QuotaUsage: Codable, Hashable {
    let used: Int
    let limit: Int
    let pct: Double
    let resetsAt: String?
}

struct SubModelBucket: Codable, Hashable {
    let name: String
    let used: Int
    let limit: Int
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
    
    func refresh() {
        // Run on main thread for UI updates
        DispatchQueue.main.async {
            self.isRefreshing = true
            self.lastError = nil
        }
        
        DispatchQueue.global(qos: .userInitiated).async {
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/bin/bash")
            // Inject Homebrew path so WindowServer apps can find npx and node
            task.arguments = ["-c", "export PATH=\"/opt/homebrew/bin:/usr/local/bin:$PATH\" && cd /Users/mingjianliu/code/quotacheck-mcp && npx tsx scripts/export-json.ts"]
            
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
                        let decoder = JSONDecoder()
                        let result = try decoder.decode([QuotaSnapshot].self, from: data)
                        DispatchQueue.main.async {
                            self.snapshots = result
                            self.isRefreshing = false
                        }
                    } catch {
                        DispatchQueue.main.async {
                            self.lastError = "Parse error: \(error.localizedDescription)"
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

struct ContentView: View {
    @StateObject var fetcher = Fetcher()
    
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("AI Quotas")
                    .font(.headline)
                Spacer()
                if fetcher.isRefreshing {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Button(action: { fetcher.refresh() }) {
                        Image(systemName: "arrow.clockwise")
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.bottom, 5)
            
            if let err = fetcher.lastError {
                Text(err)
                    .foregroundColor(.red)
                    .font(.caption)
                    .fixedSize(horizontal: false, vertical: true)
            }
            
            if fetcher.snapshots.isEmpty && !fetcher.isRefreshing && fetcher.lastError == nil {
                Text("No data yet. Refreshing...")
                    .foregroundColor(.secondary)
                    .font(.subheadline)
            }
            
            ScrollView {
                VStack(alignment: .leading, spacing: 15) {
                    ForEach(fetcher.snapshots, id: \.source) { snap in
                        SourceView(snap: snap)
                    }
                }
                .padding(.trailing, 5)
            }
            .frame(maxHeight: 500)
            
            Divider()
            
            HStack {
                Text("Refreshes automatically every 5m")
                    .font(.caption2)
                    .foregroundColor(.secondary)
                Spacer()
                Button("Quit") {
                    NSApplication.shared.terminate(nil)
                }
                .buttonStyle(.plain)
                .font(.caption)
                .foregroundColor(.secondary)
            }
        }
        .padding()
        .frame(width: 340)
        .onAppear {
            fetcher.refresh()
            Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { _ in
                fetcher.refresh()
            }
        }
    }
}

struct SourceView: View {
    let snap: QuotaSnapshot
    
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(snap.source.capitalized)
                    .font(.subheadline)
                    .bold()
                Spacer()
                Text(formatDate(snap.collectedAt))
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }
            
            if let err = snap.error {
                Text("Error: \(err)")
                    .foregroundColor(.red)
                    .font(.caption)
            } else {
                if let sess = snap.session {
                    QuotaBar(name: "Session", usage: sess)
                }
                if let weekly = snap.weekly {
                    QuotaBar(name: "Weekly", usage: weekly)
                }
                if let subs = snap.subModels, !subs.isEmpty {
                    ForEach(subs, id: \.name) { sub in
                        QuotaBar(name: sub.name, used: sub.used, limit: sub.limit, pct: sub.pct, resetsAt: sub.resetsAt)
                    }
                }
            }
        }
        .padding()
        .background(Color(NSColor.controlBackgroundColor))
        .cornerRadius(8)
    }
    
    func formatDate(_ isoString: String) -> String {
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
    let used: Int
    let limit: Int
    let pct: Double
    let resetsAt: String?

    init(name: String, usage: QuotaUsage) {
        self.name = name
        self.used = usage.used
        self.limit = usage.limit
        self.pct = usage.pct
        self.resetsAt = usage.resetsAt
    }

    init(name: String, used: Int, limit: Int, pct: Double, resetsAt: String? = nil) {
        self.name = name
        self.used = used
        self.limit = limit
        self.pct = pct
        self.resetsAt = resetsAt
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(name)
                    .font(.caption)
                Spacer()
                Text("\(used) / \(limit)")
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }
            ProgressView(value: min(pct, 100), total: 100)
                .progressViewStyle(.linear)
                .tint(pct > 90 ? .red : (pct > 75 ? .orange : .accentColor))
            if let resetsAt = resetsAt, let resetDate = parseISO(resetsAt) {
                Text("Resets \(formatReset(resetDate))")
                    .font(.caption2)
                    .foregroundColor(.secondary)
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
