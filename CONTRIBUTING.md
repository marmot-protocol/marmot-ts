# Contributing to @internet-privacy/marmots

Thank you for your interest in contributing to marmots! This document provides guidelines and information for contributors.

## Getting Started

### Prerequisites

- Node.js LTS (>= 20.x)
- TypeScript ~5.8.0 (installed via devDependencies)
- npm or yarn
- Git

### Setting Up Your Development Environment

1. Fork the repository on GitHub
2. Clone your fork locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/marmot-ts.git
   cd marmot-ts
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Create a new branch for your changes:
   ```bash
   git checkout -b feature/your-feature-name
   ```

## Development Workflow

### Available Scripts

- `npm run build` - Clean and compile the TypeScript code
- `npm run clean` - Remove the dist directory
- `npm run compile` - Compile TypeScript files
- `npm run test` - Run tests with Vitest
- `npm run format` - Format code with Prettier
- `npm run prepare` - Set up Husky git hooks

### Making Changes

1. Make your changes in the appropriate files
2. Add or update tests for your changes
3. Run linting and formatting:
   ```bash
   npm run format
   npm run lint
   ```
4. Run the test suite to ensure everything passes:
   ```bash
   npm test
   ```
5. Build the project to ensure it compiles:
   ```bash
   npm run build
   ```
