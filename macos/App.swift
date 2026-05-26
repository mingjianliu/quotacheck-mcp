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
    
    func refresh(force: Bool = false) {
        // Run on main thread for UI updates
        DispatchQueue.main.async {
            self.isRefreshing = true
            self.lastError = nil
        }
        
        DispatchQueue.global(qos: .userInitiated).async {
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/bin/bash")
            // Inject Homebrew path so WindowServer apps can find npx and node
            let forceArg = force ? " --force" : ""
            task.arguments = ["-c", "export PATH=\"/opt/homebrew/bin:/usr/local/bin:$PATH\" && cd /Users/mingjianliu/code/quotacheck-mcp && npx tsx scripts/export-json.ts\(forceArg)"]
            
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
        case "gemini-cli": return "cpu.fill"
        case "gemini-web": return "globe"
        case "antigravity": return "bolt.fill"
        default: return "sparkles"
        }
    }

    private func sourceColor(for source: String) -> Color {
        switch source.lowercased() {
        case "claude-code": return Color(red: 0.9, green: 0.45, blue: 0.3)
        case "gemini-cli": return Color.blue
        case "gemini-web": return Color.teal
        case "antigravity": return Color.purple
        default: return Color.indigo
        }
    }
    
    private func formatSourceName(_ source: String) -> String {
        switch source.lowercased() {
        case "claude-code": return "Claude Code"
        case "gemini-cli": return "Gemini CLI"
        case "gemini-web": return "Gemini Web"
        case "antigravity": return "Antigravity"
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
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(name.capitalized)
                    .font(.system(.caption, design: .rounded))
                    .fontWeight(.medium)
                    .foregroundColor(.primary.opacity(0.8))
                Spacer()
                Text(limit == 100 ? "\(used)%" : "\(used) / \(limit)")
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
