//
//  WaveformView.swift
//  canopy
//
//  5-bar waveform that reacts to a live audio power level (0…1).
//  At silence it breathes gently; as power grows the bars extend.
//

import SwiftUI

struct WaveformView: View {
    /// Live audio RMS power, 0.0 (silent) → 1.0 (peak).
    let audioPowerLevel: CGFloat

    var color: Color = .white

    private let barCount = 5
    private let barProfile: [CGFloat] = [0.4, 0.7, 1.0, 0.7, 0.4]

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 36.0)) { ctx in
            HStack(alignment: .center, spacing: 2) {
                ForEach(0..<barCount, id: \.self) { i in
                    RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                        .fill(color)
                        .frame(width: 2, height: barHeight(for: i, date: ctx.date))
                }
            }
            .shadow(color: color.opacity(0.5), radius: 5, x: 0, y: 0)
            .animation(.linear(duration: 0.08), value: audioPowerLevel)
        }
    }

    private func barHeight(for index: Int, date: Date) -> CGFloat {
        let phase = CGFloat(date.timeIntervalSinceReferenceDate * 3.6) + CGFloat(index) * 0.35
        let normalized = max(audioPowerLevel - 0.008, 0)
        let eased = pow(min(normalized * 2.85, 1), 0.76)
        let reactive = eased * 10 * barProfile[index]
        let idle = (sin(phase) + 1) / 2 * 1.5
        return 3 + reactive + idle
    }
}

#Preview("Idle") {
    WaveformView(audioPowerLevel: 0.0)
        .padding(40).background(Color.black)
}

#Preview("Speaking") {
    WaveformView(audioPowerLevel: 0.8)
        .padding(40).background(Color.black)
}
