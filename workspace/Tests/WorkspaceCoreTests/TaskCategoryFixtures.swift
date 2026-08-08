import WorkspaceCore

extension TaskCategory {
    static let lightResearch = TaskCategory(
        rawValue: "light_research", label: "Light research")
    static let heavyResearch = TaskCategory(
        rawValue: "heavy_research", label: "Heavy research / synthesis")
    static let simpleCoding = TaskCategory(
        rawValue: "simple_coding", label: "Simple coding")
    static let standardCoding = TaskCategory(
        rawValue: "standard_coding", label: "Standard coding")
    static let complexCoding = TaskCategory(
        rawValue: "complex_coding", label: "Complex coding")
    static let codeReview = TaskCategory(
        rawValue: "code_review", label: "Code review")
    static let planning = TaskCategory(rawValue: "planning", label: "Planning")
    static let debugging = TaskCategory(rawValue: "debugging", label: "Debugging")
    static let summarization = TaskCategory(
        rawValue: "summarization", label: "Summarization")
    static let unclassified = TaskCategory(
        rawValue: "default", label: "Everything else")
}
