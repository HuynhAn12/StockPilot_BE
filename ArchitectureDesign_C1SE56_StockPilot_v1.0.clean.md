

> **Diagram:** See the original Architecture Design Document. The prose and mappings below are the normative architecture description stored in source control.

**CAPSTONE PROJECT 1**

**StockPilot \- Smart Inventory and Pricing Decision Support System**

**ARCHITECTURE DESIGN DOCUMENT**  
Version 1.0  
Date: September 20th, 2026

> > > > > > **MENTOR              : MSc. Thuan, Nguyen Trung**  
> > > > > > **PROJECT TEAM    : C1SE.56 Team**  
> > > > > > **TEAM MEMBERs   : An, Huynh Thi Thu**  
Sang, Huynh Thanh  
Vi, Huynh Pham Long  
Khiem, Huynh Bui Gia  
Hieu, Tran Minh

**INTERNATIONAL SCHOOL**

**Project Information**

| Project acronym | StockPilot |  |  |  |
| :---: | ----- | ----- | :---: | :---: |
| **Project Title** | Smart Inventory and Pricing Decision Support System |  |  |  |
| **Start Date** | 26th Aug 2026 | **End Date** | 06th Dec 2026 |  |
| **Lead Institution** | International School, Duy Tan University |  |  |  |
| **Project Mentor** | MSc. Thuan, Nguyen Trung |  |  |  |
| **Scrum master & contact details** | An, Huynh Thi Thu
Email: thuan12032005@gmail.com
Tel: 0367634257   |  |  |  |
| **Partner Organization** | Duy Tan University |  |  |  |
| **Project Web URL** |  |  |  |  |
| **Team members** | **Name** | **Email** |  | **Tel** |
|  | Sang, Huynh Thanh | sang28097@gmail.com |  | 0938325682 |
|  | Vi, Huynh Pham Long | longvihuynh23@gmail.com |  | 0362092205 |
|  | Khiem, Huynh Bui Gia | nobitv.2611@gmail.com |  | 0971527541 |
|  | Hieu, Tran Minh | minh33hieupc@gmail.com |  | 0971527541 |

**Architecture Design Document**

| Document Title | Architecture Design Document |  |  |
| ----- | ----- | ----- | ----- |
| **Reporting Period** | September, 2026 |  |  |
| **Author(s)**  | C1SE.56 Team |  |  |
| Team Information | **Name** | **Role** |  |
|  | Sang, Huynh Thanh | Member |  |
|  | Vi, Huynh Pham Long | Member |  |
|  | Khiem, Huynh Bui Gia | Member |  |
|  | Hieu, Tran Minh | Member |  |
| **Date** | 20th Sep, 2026 | **Filename** | ArchitectureDesign\_StockPilot\_v1.0.docx |
| **Access** | Project and CMU Program |  |  |

| Document History |  |  |
| ----- | :---: | ----- |
| **Version** | **Date** | **Comments** |
| V1.0 | Sep 20th, 2026 | Initial StockPilot architecture design based on approved proposal and current database design |
|  |  |  |
|  |  |  |

**Document Approvals**

**The following signatures are required for approval of this document.**

| MSc. Thuan, Nguyen Trung
Mentor

 |  | Date:  |
| :---- | :---- | :---- |
| An, Huynh Thi Thu
Scrum Master   |  |  Date:  |

Contents  
[**1\. Introduction**	6](#heading)

[**1.1 Purpose**	6](#1.1-purpose)

[**2\. Project Overview**	6](#2.-project-overview)

[**2.1 Business needs**	6](#2.1-business-needs)

[**2.2 Proposed solution**	6](#2.2-proposed-solution)

[**2.3 Project goal**	6](#2.3-project-goal)

[**3\. Architectural drivers**	7](#3.-architectural-drivers)

[**3.1 Functional requirements**	7](#3.1-functional-requirements)

[**3.2 Business constraints**	7](#3.2-business-constraints)

[**3.3 Technical constraints**	7](#3.3-technical-constraints)

[**3.4 Quality Attribute**	7](#3.4-quality-attribute)

[**3.5 Context Diagram**	9](#3.5-context-diagram)

[**4 C\&C view**	11](#4.-c&c-view)

[**5\. Module view**	15](#5.-module-view)

[**6\. Allocation view**	19](#6.-allocation-view)

# **1\. Introduction**

## **1.1 Purpose** {#1.1-purpose}

This document describes the architecture of StockPilot. It covers:  
\- The project background, business needs, proposed solution, scope, main users, and operating assumptions.  
\- The architectural drivers, including functional requirements, constraints, quality attributes, security, data consistency, and explainability.  
\- The system design through the Context, Component-and-Connector (C\&C), Module, and Allocation views.

# **2\. Project Overview** {#2.-project-overview}

## **2.1 Business needs** {#2.1-business-needs}

Small and medium-sized retailers often manage sales, inventory, and pricing with basic POS functions, experience, or spreadsheets. This makes it difficult to identify stockout, overstock, and slow-moving products early and to justify pricing decisions. StockPilot brings inventory management, sales analytics, and decision support into one web system for Vietnamese SME retailers.

## **2.2 Proposed solution** {#2.2-proposed-solution}

StockPilot is a web application built with React and TypeScript on the frontend, Node.js and Express.js on the backend, and MySQL 8.4 with Prisma for data access. The system manages products, orders, returns, inventory, analytics, alerts, and pricing recommendations. A TypeScript Decision Engine calculates inventory risks and pricing recommendations from business rules. The AI Decision Assistant is used to explain authorized data and Decision Engine results; it does not change business data by itself.

## **2.3 Project goal** {#2.3-project-goal}

The goal of StockPilot is to support daily retail operations and provide clear inventory and pricing decision support. The main functions are:

\- Account and access management for Store Owner, Warehouse Staff, and Admin.  
\- Product, category, variant, order, return, inventory movement, adjustment, and stock-taking management.  
\- Dashboard and sales analytics using indexed queries and the DailySalesSummary table.  
\- Detection of the three main inventory risks: stockout, overstock, and slow-moving products, with prioritized Smart Alerts.  
\- Pricing recommendations based on cost, margin, sales velocity, demand trend, and inventory condition.  
\- AI Decision Assistant for explaining authorized shop data, alerts, and recommendations. It cannot directly change inventory or product prices.

# **3\. Architectural drivers** {#3.-architectural-drivers}

## **3.1 Functional requirements** {#3.1-functional-requirements}

Reference:

| Title | Resource |
| :---- | :---- |
| Project proposal | C1SE.56 StockPilot Proposal v1.0 |
| Database design / source | Current StockPilot MySQL database schema v2.0 |

## **3.2 Business constraints** {#3.2-business-constraints}

The main business constraints are:  
\- The project runs from August 26th, 2026 to December 06th, 2026 and must follow the fixed Capstone milestones.  
\- Team size: 5 members. A modular monolith is used to keep implementation and deployment manageable within the Capstone schedule.  
\- The MVP supports one store per account and one warehouse/location. Pricing recommendations are advisory and require user confirmation.

## **3.3 Technical constraints** {#3.3-technical-constraints}

The main technologies are:  
\- Frontend: React.js \+ TypeScript \+ Vite; Recharts for charts.  
\- Backend: Node.js 24 LTS \+ Express.js. The backend is organized as a modular monolith with controller, service, and data-access layers.  
\- Database: MySQL 8.4/InnoDB with Prisma ORM and Prisma Migrate.  
\- Decision support and tools: TypeScript Decision Engine, OpenAI Responses API (backend only), GitHub, Figma, Postman, Visual Studio Code, and MySQL Workbench.

## **3.4 Quality Attribute** {#3.4-quality-attribute}

Table 1: Quality Attributes: Reliability

| Quality Attributes : Reliability | ID : QA01 |
| :---- | :---- |
| **Stimulus** | Order or inventory update fails before completion |
| **Source(s) of the stimulus** | User, application, or database |
| **Relevant environmental conditions** | Normal system operation |
| **Artifacts** | Order and Inventory modules |
| **System response** | Use database transactions so related order and inventory changes are committed together or rolled back together |
| **Response measure(s)** | No partial order/inventory update is kept after a failed transaction |

Table 2: Quality Attributes: Performance

| Quality Attributes : Performance | ID : QA02 |
| :---- | :---- |
| **Stimulus** | User opens the dashboard, analytics page, or submits a normal request |
| **Source(s) of the stimulus** | Authenticated user |
| **Relevant environmental conditions** | Expected MVP workload and normal network conditions |
| **Artifact** | Web application, REST API, and MySQL database |
| **System response** | Use indexes, pagination, and DailySalesSummary for repeated analytical queries |
| **Response measure(s)** | Normal user requests and standard dashboard/analytical queries respond within 2 seconds under the expected MVP workload |

Table 3: Quality Attributes: Maintainability

| Quality Attributes : Maintainability | ID : QA03 |
| :---- | :---- |
| **Stimulus** | Developer changes a risk rule, pricing rule, or business module |
| **Source(s) of the stimulus** | Development team |
| **Relevant environmental conditions** | Maintenance and future development |
| **Artifact** | Modular monolith and Decision Engine |
| **System response** | Keep business rules inside their modules and use clear controller, service, and data-access boundaries |
| **Response measure(s)** | A module can be changed and tested without rewriting unrelated modules |

Table 4: Quality Attributes: Security

| Quality Attributes : Security | ID : QA04 |
| :---- | :---- |
| **Stimulus** | Unauthorized, cross-store, malformed, or abusive request |
| **Source(s) of the stimulus** | External actor or authenticated user |
| **Relevant environmental conditions** | Internet-facing deployment |
| **Artifact** | API, authentication/RBAC, validation, and AI integration |
| **System response** | Authenticate users, check roles and store access, validate input, rate-limit sensitive endpoints, and keep secrets on the backend |
| **Response measure(s)** | Unauthorized requests are rejected; passwords are hashed; API and OpenAI credentials are not exposed to the browser |

## **3.5 Context Diagram** {#3.5-context-diagram}

> **Diagram:** See the original Architecture Design Document. The prose and mappings below are the normative architecture description stored in source control.

Figure 1: Context Diagram

**System context description**

The main users of StockPilot are Store Owner, Warehouse Staff, and Admin. OpenAI is an external service used by the AI Decision Assistant to provide explanations and decision support. MySQL is the internal database used to store and manage the system’s business data.

The main functional areas of StockPilot are:

### **\- Account & Access Management:** Handles user registration, login, profile management, password reset, account status, roles, permissions, and store access. The system also manages authentication sessions and protects user credentials and access tokens.

### **\- Product & Category Management:** Allows authorized users to create, update, archive, search, and manage product categories, products, product variants, prices, and inventory thresholds.

### **\- Order & Sales Management:** Manages sales orders, order history, returns, and refunds. When an order affects inventory, the corresponding order and inventory changes are processed consistently to maintain accurate stock information.

### **\- Inventory Management:** Maintains current stock quantities and records inventory activities, including stock-in, stock-out, inventory adjustments, and stock-taking history.

### **\- Dashboard & Sales Analytics:** Provides business information such as revenue, order volume, product performance, inventory status, sales velocity, sales trends, and profit margin. The system also prepares summarized sales data to support faster analytical queries.

### **\- Inventory Risk & Smart Alerts:** Uses the Decision Engine to analyze sales velocity, demand trends, days of inventory coverage, stock levels, and configured thresholds. The system identifies potential stockout, overstock, and slow-moving product risks and generates alerts with their priority and supporting factors.

### **\- Pricing Decision Support:** Analyzes factors such as cost price, current selling price, profit margin, sales velocity, demand trends, and inventory condition to provide pricing recommendations. Users can accept, reject, or modify a recommendation, and applied price changes are recorded for future reference.

### **\- AI Decision Assistant:** Provides AI-based explanations and decision support based on authorized business data and the results of the Decision Engine. The system sends only the data necessary for each request to OpenAI through the backend and excludes customer personal information and sensitive credentials. The AI Assistant provides explanations and recommendations but cannot directly modify business data.

# **4\. C\&C view** {#4.-c&c-view}

> **Diagram:** See the original Architecture Design Document. The prose and mappings below are the normative architecture description stored in source control.

Figure 2: C\&C View

**Component Mapping:**

| Component: Main runtime parts of StockPilot |  |
| :---- | :---- |
| **Name** | **Role** |
| React Web UI | Displays role-based pages, forms, dashboard charts, and calls the REST API. |
| REST API / Middleware | Receives HTTP requests and handles routing, Zod validation, authentication, RBAC, rate limiting, and errors. |
| Auth & RBAC | Handles login, tokens, account status, roles, permissions, and store access. |
| Catalog & Order services | Manages categories, products, variants, orders, returns, and refunds. |
| Inventory service | Updates stock levels and records stock-in, stock-out, adjustments, and stock-taking movements. |
| Analytics service | Calculates revenue, sales velocity, trends, and margins using transaction data and DailySalesSummary. |
| Decision Engine | Calculates inventory risk, priority, and pricing recommendations using configured TypeScript rules. |
| Alerts & Pricing services | Stores alerts and pricing recommendations, tracks user decisions, and records price history. |
| AI Decision Assistant | Selects permitted business data, calls OpenAI from the backend, and returns explanations without changing business records. |

**Repository:**

| Repository: Data stored or read by StockPilot modules |  |
| :---- | :---- |
| **Name** | **Role** |
| Transactional data | Store/User, Category/Product/Variant, Order/OrderItem/Returns, Inventory/InventoryTransaction, and StockTake data in MySQL/InnoDB. |
| Analytics & decision data | DailySalesSummary, Alert, PricingRecommendation, and PriceHistory used by analytics and decision-support features. |
| Configuration & operational data | EngineConfig, SystemSetting, ImportJob/ImportError, AI conversation/usage, Notification, and AuditLog data. |

**Connector:**

| Connector: Runtime communication between StockPilot components |  |
| :---- | :---- |
| **Name** | **Role** |
| HTTPS / REST JSON | The browser calls backend endpoints over HTTPS using JSON requests and responses. |
| In-process service call | Controllers and services call each other through internal TypeScript interfaces inside the modular monolith. |
| Database / external API | Prisma reads/writes MySQL data. AiAssistantService calls the OpenAI Responses API over HTTPS. |

**Prose:**

**\- Order and inventory transaction flow:**  
**\- Input: authenticated user/store information, order items or stock-movement request, product/variant IDs, quantity, and reason.**  
**\- Process:**  
\- The API validates the request and checks the user role and store before calling the related service.  
\- For order completion or stock-out, InventoryService checks the current balance and prevents the quantity from becoming negative. Inventory and InventoryTransaction are updated in the same MySQL transaction.  
\- OrderItem keeps the product name, SKU, price, and cost at the time of sale. A return checks the original order and previously returned quantity before the refund or stock return is recorded.  
\- After the transaction is committed, analytics, alerts, and notifications can be refreshed by background jobs.  
**\- Output: consistent order and inventory data, a stock-movement history, and updated data for analytics and decision support.**

**\- Analytics and Decision Engine flow:**  
**\- Input: DailySalesSummary, current inventory, product cost and price, EngineConfig, historical sales data, and engine version.**  
**\- Process:**  
\- Scheduled or on-demand jobs calculate sales velocity, demand trend, days of cover, demand variation, safety-stock information, and margin.  
\- The Decision Engine applies configured rules to the three main inventory risks: stockout, overstock, and slow-moving products. Confidence is reduced when there is not enough historical data.  
\- Pricing rules calculate the minimum allowed price from cost and margin settings, then limit price increases or decreases to the configured range. If the evidence is weak or conflicting, the result is MAINTAIN.  
\- AlertService and PricingService store the result, explanation, confidence, and engine version. Old pricing recommendations can be marked as expired when the related data changes.  
**\- Output:**  
\- Prioritized inventory alerts with the main reasons and factors used by the Decision Engine.  
\- Pricing recommendations with current price, recommended price, final user-selected price, and decision status before any product price is updated.

**\- AI Decision Assistant flow:**  
**\- Input:**  
\- An authenticated natural-language question and only the store data needed to answer it, taken from analytics, alerts, and pricing recommendations.  
\- The Decision Engine result and related business summaries. Customer PII, passwords, tokens, database credentials, and unrelated records are excluded.  
\- Instructions tell the AI Assistant to explain the provided data, state when information is missing, and not perform business actions.  
**\- Process:**  
\- The API checks access, question size, and usage limits. AiAssistantService then prepares the required business context.  
\- The backend calls the OpenAI Responses API over HTTPS and handles timeout or API errors. If structured output is used, the response is validated before the application uses it.  
\- Conversation and token-usage records may be saved for review and cost control. Production logs should not store unnecessary sensitive data.  
\- If OpenAI is unavailable, the core StockPilot functions continue to work and the user receives a fallback message.  
**\- Output:**  
\- A natural-language explanation based on the authorized StockPilot data sent in the request.  
\- The AI integration does not directly create or update Product, Inventory, Order, Alert, PricingRecommendation, or PriceHistory records.

# **5\. Module view** {#5.-module-view}

> **Diagram:** See the original Architecture Design Document. The prose and mappings below are the normative architecture description stored in source control.

Figure 3: Module View

**PACKAGES**

| PACKAGE: Main StockPilot modules |  |
| :---- | :---- |
| **Name** | **Role** |
| Presentation | React pages, route guards, forms, charts, and shared UI components. |
| API / Middleware | Express routes/controllers, validation, authentication, RBAC, rate limiting, and error handling. |
| Auth / User / Store | Account management, user roles/status, store settings, and token handling. |
| Catalog | Category, Product, and ProductVariant management, search, archive, prices, and thresholds. |
| Inventory | Current inventory balance, movement history, stock-taking, adjustments, and stock thresholds. |
| Orders / Returns | Order lifecycle, sale-time item data, stock deduction, returns, refunds, and status checks. |
| Analytics | Dashboard metrics, DailySalesSummary, revenue, sales velocity, trends, margins, and reports. |
| Decision / Pricing / Alerts | Inventory-risk calculation, alert priority, pricing recommendations, and user decision history. |
| Import / AI / Notification | CSV/Excel import/export, AI Assistant integration, notifications, and usage tracking. |
| Data / Audit / Jobs | Prisma data access/migrations, AuditLog, SystemSetting, and scheduled jobs. |

**CLASSES / SERVICES**

| CLASS / SERVICE: Main application services |  |
| :---- | :---- |
| **Name** | **Role** |
| App Router \+ Feature Views | Frontend routing and role-based feature pages. |
| AuthService | Registration, login, password verification/reset, profile updates, access/refresh tokens, account status, and store access checks. |
| ProductService | Validates and manages categories, products, variants, prices, and inventory thresholds. |
| InventoryService | Performs stock operations and writes InventoryTransaction records in the same database transaction. |
| OrderService | Creates and updates orders, keeps sale-time item values, and coordinates stock deduction. |
| ReturnService | Validates return quantities, records refunds, and returns stock when applicable. |
| AnalyticsService | Calculates dashboard metrics and analytical summaries from sales and inventory data. |
| DecisionEngine | Runs the configured inventory-risk and pricing rules and returns the calculation result. |
| RiskEvaluator | Evaluates stockout, overstock, and slow-moving risk, then returns risk score, priority, confidence, and factors. |
| PricingEvaluator | Checks the minimum-margin rule and recommends INCREASE, DECREASE, or MAINTAIN within configured limits. |
| AlertService | Creates/updates alerts, prevents duplicates, and manages alert status and notifications. |
| PricingService | Stores recommendations, handles accept/reject/modify decisions, applies approved prices, and records PriceHistory. |
| ImportService | Parses CSV/Excel files, validates rows, shows a preview, and imports valid data through business services. |
| AiAssistantService | Prepares permitted business context, calls the OpenAI Responses API, handles errors, and records AI usage. |
| NotificationService | Creates and manages user/store notifications for alerts, recommendations, imports, and system events. |
| Audit / Admin / Job Services | Handles admin settings, audit logs, and scheduled analytics/Decision Engine jobs. |

**RESOURCES / DATA ENTITIES**

| RESOURCE: Main data entities used by StockPilot modules |  |
| :---- | :---- |
| **Name** | **Role** |
| Store / User / Tokens | Store settings, user account/role/status, and hashed refresh-token records. |
| Category / Product / Variant | Catalog data, SKU/barcode, cost price, selling price, and minimum-margin settings. |
| Inventory / Movement | Current stock balance and stock-movement history with source, user, and before/after quantity. |
| Order / Return | Orders, item snapshots, returns, refund amounts, and order/return status. |
| DailySalesSummary | Daily sales quantity, revenue, COGS, return quantity, and order count by store/product/date. |
| Alert | Alert type, severity, risk score, confidence, factors, status, and resolution information. |
| PricingRecommendation / PriceHistory | Current/recommended/final price, factors, engine version, user decision, and applied price history. |
| Config / Import / AI / Audit | EngineConfig, SystemSetting, import jobs/errors, AI conversations/usage, notifications, and AuditLog. |

**RELATIONSHIP TYPES**

| RELATIONSHIP: Main dependency and data relationships |  |
| :---- | :---- |
| **Name** | **Role** |
| Dependency | A module uses another module through its public service or data contract instead of directly using internal logic. |
| Association | Related business records use IDs/foreign keys, while the service layer also checks store ownership. |
| Transactional composition | Order, return, inventory, and pricing updates that must stay consistent are handled in one application flow and database transaction. |

# **6\. Allocation view** {#6.-allocation-view}

> **Diagram:** See the original Architecture Design Document. The prose and mappings below are the normative architecture description stored in source control.
Figure 4\. Allocation view

**Description**

| Element | Description |
| :---- | :---- |
| Web client / frontend hosting | A supported browser loads the React/Vite frontend over HTTPS and calls the public backend API. |
| Backend runtime | The Node.js/Express backend runs the API, business services, Decision Engine, imports, notifications, audit logging, and scheduled jobs. Secrets stay on the server. |
| Cloud data & external AI services | Managed MySQL 8.4/InnoDB stores StockPilot data and backups. The backend calls OpenAI over HTTPS for AI explanations. |

**Prose:**

StockPilot is deployed as a web application. Users access the React frontend over HTTPS. Database credentials and the OpenAI API key stay on the backend.

The Node.js/Express backend contains authentication, business services, the Decision Engine, import/export functions, notifications, audit logging, and scheduled jobs.

MySQL 8.4/InnoDB stores the system data. Database changes are managed through migrations, and production deployment includes indexes, a restricted database account, and backup/recovery procedures.

OpenAI is called only by the backend for AI explanations. If the AI service is unavailable, product, order, inventory, analytics, alerts, and pricing functions continue to work. CI is used for linting, tests, type checks, and builds.
