import WorkspaceCore

extension TaskCategory {
    static let simpleCoding = TaskCategory(
        rawValue: "simple_coding", label: "Simple coding")
    static let complexCoding = TaskCategory(
        rawValue: "complex_coding", label: "Complex coding")
    static let unclassified = TaskCategory(
        rawValue: "default", label: "Everything else")
}
