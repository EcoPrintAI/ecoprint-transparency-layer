# EcoPrint Transparency Layer — Project Brief

## Hackathon Project

This project is a prototype for the IBM Bob 2.0 Hackathon.

## Problem

Modern software and AI workloads can consume significant compute, energy,
and infrastructure resources, but developers often lack clear visibility
into the operational and environmental impact associated with individual
workloads.

The information needed to understand that impact is frequently distributed
across infrastructure telemetry, workload metadata, application data, and
other operational sources.

This makes it difficult to connect a software workload to measurable
infrastructure impact and turn that information into useful engineering
insight.

## Proposed Solution

EcoPrint Transparency is a developer-facing prototype that explores
how infrastructure measurements and workload context can be connected into
a common transparency layer.

The prototype will demonstrate a workflow for:

1. Collecting or receiving infrastructure measurements.
2. Normalizing measurements into a consistent structure.
3. Associating measurements with workload or execution context.
4. Calculating relevant impact metrics.
5. Presenting the resulting information in a form developers can understand
   and use.

## Developer Workflow Being Improved

The prototype focuses on improving the workflow of understanding and
investigating the operational impact of software workloads.

The goal is to reduce the manual effort required to gather information from
different sources, connect workload activity to infrastructure measurements,
and interpret the resulting data.

## Prototype Boundary

This hackathon project is a standalone prototype.

It must remain separate from proprietary EcoPrint AI production systems.

The prototype must not import, copy, recreate, or modify proprietary
implementation details from SigSense, Connect, or other proprietary
EcoPrint components unless explicitly approved.

## Expected Outcome

The finished prototype should demonstrate a working end-to-end workflow
rather than only a static concept.

The demonstration should make it possible to show:

- what information enters the transparency layer;
- how information is normalized;
- how workload context is associated with measurements;
- what calculations or transformations occur;
- what information is produced for the developer; and
- how the workflow reduces manual investigation or interpretation.

## IBM Bob Usage

IBM Bob IDE is a core development component of this project.

Bob should be used for meaningful development tasks throughout the project,
including planning, implementation, testing, analysis, and/or review.

Relevant Bob task session consumption summaries and exported task histories
will be preserved in `bob_sessions/` as required by the hackathon.

## Evidence

Meaningful development milestones should produce evidence that can be
captured and preserved for the final submission.

Do not modify or delete previously captured hackathon evidence.

## Current Status

The project repository and development environment have been established.
Application implementation is the next development phase.