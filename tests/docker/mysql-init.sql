SET NAMES utf8mb4;
CREATE TABLE customers (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(200),
  balance DECIMAL(24,8) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB;
INSERT INTO customers(name,email,balance) VALUES
 ('Ada Lovelace','ada@example.test',1250.50000000),
 ('Grace Hopper','grace@example.test',9007199254740993.12345678),
 ('Edsger Dijkstra',NULL,0),
 ('Margaret Hamilton','margaret@example.test',42);
CREATE TABLE projects (id BIGINT PRIMARY KEY AUTO_INCREMENT, customer_id BIGINT, name VARCHAR(100),
 FOREIGN KEY(customer_id) REFERENCES customers(id)) ENGINE=InnoDB;
INSERT INTO projects(customer_id,name) VALUES (1,'Analytical engine'),(2,'Compiler');
CREATE VIEW customer_projects AS SELECT c.name AS customer, p.name AS project FROM customers c JOIN projects p ON p.customer_id=c.id;
CREATE TABLE data_types (id INT PRIMARY KEY, wide_int BIGINT UNSIGNED, precise DECIMAL(24,8), moment DATETIME(6),
 document JSON, payload VARBINARY(16), label VARCHAR(100), missing VARCHAR(10)) ENGINE=InnoDB;
INSERT INTO data_types VALUES (1,18446744073709551615,1234567890123456.12345678,'2026-10-12 12:34:56.123456',
 '{"big":9007199254740993}',X'00FF802C','Hej 世界 👋',NULL);
CREATE TABLE numbers (n INT PRIMARY KEY) ENGINE=InnoDB;
INSERT INTO numbers WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<1000) SELECT n FROM seq;

CREATE DATABASE `team's data`;
CREATE TABLE `team's data`.switch_marker(id INT PRIMARY KEY, label VARCHAR(100)) ENGINE=InnoDB;
INSERT INTO `team's data`.switch_marker VALUES(7, 'target database');
CREATE DATABASE private_database;
CREATE USER 'browser_user'@'%' IDENTIFIED BY 'local-test-only';
GRANT ALL ON dbcommander.* TO 'browser_user'@'%';
GRANT ALL ON `team's data`.* TO 'browser_user'@'%';
-- Visibility is broader than access: discovery must check USE as well.
GRANT SHOW DATABASES ON *.* TO 'browser_user'@'%';

CREATE DATABASE comparison_target;
GRANT ALL ON comparison_target.* TO 'dbcommander'@'%';
