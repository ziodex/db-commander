IF DB_ID(N'dbcommander') IS NULL CREATE DATABASE dbcommander;
GO
USE dbcommander;
GO
IF OBJECT_ID(N'dbo.customers') IS NOT NULL RETURN;
CREATE TABLE dbo.customers (
 id BIGINT IDENTITY PRIMARY KEY, name NVARCHAR(100) NOT NULL, email NVARCHAR(200),
 balance DECIMAL(24,8) NOT NULL, created_at DATETIME2(7) NOT NULL DEFAULT SYSDATETIME()
);
INSERT dbo.customers(name,email,balance) VALUES
 (N'Ada Lovelace',N'ada@example.test',1250.50000000),
 (N'Grace Hopper',N'grace@example.test',9007199254740993.12345678),
 (N'Edsger Dijkstra',NULL,0), (N'Margaret Hamilton',N'margaret@example.test',42);
CREATE TABLE dbo.projects (id BIGINT IDENTITY PRIMARY KEY, customer_id BIGINT REFERENCES dbo.customers(id), name NVARCHAR(100));
INSERT dbo.projects(customer_id,name) VALUES (1,N'Analytical engine'),(2,N'Compiler');
CREATE TABLE dbo.data_types (
 id INT PRIMARY KEY, wide_int BIGINT, precise DECIMAL(38,18), amount MONEY,
 moment DATETIME2(7), zoned DATETIMEOFFSET(7), time_only TIME(7), date_only DATE,
 payload VARBINARY(16), label NVARCHAR(100), document NVARCHAR(MAX), missing NVARCHAR(10)
);
INSERT dbo.data_types VALUES (1,9223372036854775807,12345678901234567890.123456789012345678,922337203685477.5807,
 '2026-10-12T12:34:56.1234567','2026-10-12T12:34:56.1234567+05:30','12:34:56.1234567','0001-01-01',
 0x00FF802C,N'Hej 世界 👋',N'{"big":9007199254740993}',NULL);
CREATE TABLE dbo.numbers(n INT PRIMARY KEY);
INSERT dbo.numbers SELECT TOP(1000) ROW_NUMBER() OVER(ORDER BY (SELECT NULL)) FROM sys.all_objects a CROSS JOIN sys.all_objects b;
GO
CREATE OR ALTER VIEW dbo.customer_projects AS SELECT c.name AS customer,p.name AS project FROM dbo.customers c JOIN dbo.projects p ON p.customer_id=c.id;
GO
USE master;
IF SUSER_ID(N'dbcommander') IS NULL CREATE LOGIN dbcommander WITH PASSWORD='Local-Test-Only!2026', CHECK_POLICY=OFF;
GO
USE dbcommander;
IF USER_ID(N'dbcommander') IS NULL CREATE USER dbcommander FOR LOGIN dbcommander;
ALTER ROLE db_owner ADD MEMBER dbcommander;
GO
USE master;
CREATE DATABASE [team's data];
GO
CREATE DATABASE private_database;
GO
CREATE LOGIN browser_user WITH PASSWORD='Local-Test-Only!2026', CHECK_POLICY=OFF, DEFAULT_DATABASE=dbcommander;
CREATE USER browser_user FOR LOGIN browser_user;
GO
USE dbcommander;
CREATE USER browser_user FOR LOGIN browser_user;
ALTER ROLE db_owner ADD MEMBER browser_user;
GO
USE [team's data];
CREATE USER browser_user FOR LOGIN browser_user;
ALTER ROLE db_owner ADD MEMBER browser_user;
CREATE TABLE dbo.switch_marker(id INT PRIMARY KEY, label NVARCHAR(100));
INSERT dbo.switch_marker VALUES(7,N'target database');
GO
